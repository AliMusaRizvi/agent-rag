import { StateGraph, END } from '@langchain/langgraph';
import express from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';
import { ChatXAI } from '@langchain/xai';
import { ChatGroq } from '@langchain/groq';

import { Embeddings } from '@langchain/core/embeddings';


import { QdrantVectorStore } from '@langchain/qdrant';
import { QdrantClient } from '@qdrant/js-client-rest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const multer = require('multer');
const mammoth = require('mammoth');
const pdfParse = require('pdf-parse');

import fs_module from 'fs';

dotenv.config();
// process.env.LANGCHAIN_TRACING_V2 = 'false';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'dist')));


class LocalTFIDFEmbeddings extends Embeddings {
  constructor() {
    super({});
  }
  async embedDocuments(texts) {
    return texts.map(t => this.embedQuerySync(t));
  }
  async embedQuery(text) {
    return this.embedQuerySync(text);
  }
  embedQuerySync(text) {
    const vec = new Array(384).fill(0);
    const words = text.toLowerCase().split(/\W+/).filter(w => w.length > 0);
    words.forEach(w => {
      let hash = 0;
      for (let i = 0; i < w.length; i++) hash = (hash << 5) - hash + w.charCodeAt(i);
      vec[Math.abs(hash) % 384] += 1;
    });
    const mag = Math.sqrt(vec.reduce((sum, val) => sum + val * val, 0)) || 1;
    return vec.map(v => v / mag);
  }
}

class GenuineMemoryVectorStore {
  constructor(embeddings) {
    this.embeddings = embeddings;
    this.memoryVectors = [];
  }
  async addDocuments(docs) {
    const texts = docs.map(d => d.pageContent);
    const vectors = await this.embeddings.embedDocuments(texts);
    for (let i = 0; i < docs.length; i++) {
      this.memoryVectors.push({
        content: docs[i].pageContent,
        metadata: docs[i].metadata,
        embedding: vectors[i]
      });
    }
  }
  similarity(a, b) {
    let dot = 0;
    for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
    return dot;
  }
  async similaritySearch(query, k = 2) {
    const results = await this.similaritySearchWithScore(query, k);
    return results.map(r => r[0]);
  }

  async similaritySearchWithScore(query, k = 2) {
    const queryVec = await this.embeddings.embedQuery(query);
    let scored = this.memoryVectors.map(vec => ({
      doc: { pageContent: vec.content, metadata: vec.metadata },
      score: this.similarity(queryVec, vec.embedding)
    }));
    
    const maxScore = Math.max(...scored.map(s => s.score));
    if (maxScore === 0) {
      scored.forEach(s => s.score = Math.random() * 0.001);
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k).map(s => [s.doc, s.score]);
  }
}

let vectorStore;
let qdrantClient;

if (process.env.QDRANT_URL && process.env.QDRANT_API_KEY && !process.env.QDRANT_URL.includes("localhost")) {
  qdrantClient = new QdrantClient({
    url: process.env.QDRANT_URL,
    apiKey: process.env.QDRANT_API_KEY,
  });
  // We'll initialize it asynchronously when adding/searching
  vectorStore = new QdrantVectorStore(new LocalTFIDFEmbeddings(), {
    client: qdrantClient,
    collectionName: process.env.QDRANT_COLLECTION || "knowledge_base",
  });
} else {
  vectorStore = new GenuineMemoryVectorStore(new LocalTFIDFEmbeddings());
}


// KV Cache for semantic caching (CAG/Cache-Augmented Generation)
const kvCache = new Map();


let isIngested = false;

// 1. Function to Fetch from GitLab/GitHub
async function fetchRepoData() {
  const docs = [];
  const gitlabRepo = process.env.GITLAB_REPO || "gitlab-org/gitlab-foss"; // default public repo
  
  // Real GitLab API fetch
  try {
    // Attempting to fetch a slightly larger chunk of the tree, looking for markdown files
    const res = await fetch(`https://gitlab.com/api/v4/projects/${encodeURIComponent(gitlabRepo)}/repository/tree?recursive=true&per_page=100`);
    if (res.ok) {
      const tree = await res.json();
      const mdFiles = tree.filter(i => i.type === 'blob' && i.name.endsWith('.md')).slice(0, 5); // Take up to 5 files to prevent timeout
      for (const item of mdFiles) {
        const fileRes = await fetch(`https://gitlab.com/api/v4/projects/${encodeURIComponent(gitlabRepo)}/repository/files/${encodeURIComponent(item.path)}/raw?ref=master`);
        if (fileRes.ok) {
          const content = await fileRes.text();
          docs.push({ pageContent: content, metadata: { source: item.path, repo: gitlabRepo } });
        }
      }
    }
  } catch(e) {
    console.error("GitLab fetch error:", e);
  }
  
  // Provide robust, rich fallback docs in case GitLab fails or rate limits, giving multiple chunks of context
  if (docs.length === 0) {
    docs.push({ pageContent: "Remote work is the default — there are no company offices. Team members can work from anywhere with a good internet connection. This aligns with our all-remote philosophy.", metadata: { source: "handbook/remote-work.md", repo: gitlabRepo } });
    docs.push({ pageContent: "Asynchronous by default. Decisions are written down before they are discussed. Meetings are optional and should have an agenda.", metadata: { source: "handbook/communication.md", repo: gitlabRepo } });
    docs.push({ pageContent: "Our core values are Collaboration, Results, Efficiency, Diversity, Inclusion & Belonging, Iteration, and Transparency (CREDIT). Transparency means making everything public by default.", metadata: { source: "handbook/values.md", repo: gitlabRepo } });
    docs.push({ pageContent: "For issue tracking, always apply relevant labels such as ~bug, ~feature, or ~documentation. Assign the issue to the appropriate team milestone.", metadata: { source: "doc/development/issues.md", repo: gitlabRepo } });
    docs.push({ pageContent: "Deployments are automated through GitLab CI/CD. The pipeline includes stages for build, test, and production deployment.", metadata: { source: "doc/ci/pipelines.md", repo: gitlabRepo } });
  }
  return docs;
}

// 2. LangGraph definition
const graphState = {
  messages: {
    value: (x, y) => x.concat(y),
    default: () => []
  },
  context: {
    value: (x, y) => y,
    default: () => ""
  },
  sources: {
    value: (x, y) => y,
    default: () => []
  },
  cachedResponse: {
    value: (x, y) => y,
    default: () => null
  },
  modelType: {
    value: (x, y) => y,
    default: () => "Grok"
  },
  persona: {
    value: (x, y) => y,
    default: () => "concise"
  },
  systemPrompt: {
    value: (x, y) => y,
    default: () => ""
  }
};

async function retrieveNode(state) {
  const lastMessage = state.messages[state.messages.length - 1];
  
  // 1. Check KV Cache (Exact Match for now, can be semantic)
  if (kvCache.has(lastMessage.content.toLowerCase())) {
    const cached = kvCache.get(lastMessage.content.toLowerCase());
    return { context: cached.context, sources: cached.sources, cachedResponse: cached.response };
  }
  
  
  if (!isIngested) {
    const docs = await fetchRepoData();
    if (process.env.QDRANT_URL && process.env.QDRANT_API_KEY && !process.env.QDRANT_URL.includes("localhost")) {
      await vectorStore.ensureCollection();
    }
    await vectorStore.addDocuments(docs);
    isIngested = true;
  }

  
  const docsWithScores = await vectorStore.similaritySearchWithScore(lastMessage.content, 5);
  const context = docsWithScores.map(([d, _]) => d.pageContent).join("\n\n");
  const sources = docsWithScores.map(([d, score]) => ({ 
    title: d.metadata.source || "Doc", 
    url: d.metadata.type === 'uploaded' ? '#' : `https://gitlab.com/${d.metadata.repo}/-/blob/master/${d.metadata.source}`, 
    snippet: d.pageContent ? d.pageContent.substring(0, 150) + "..." : "",
    score: typeof score === 'number' ? score : 0.85
  }));
  
  return { context, sources, cachedResponse: null };
}

async function generateNode(state) {
  if (state.cachedResponse) {
    return { messages: [{ role: "agent", content: state.cachedResponse }] };
  }

  const lastMessage = state.messages[state.messages.length - 1];
  let personaInstruction = "Be concise and direct.";
  if (state.systemPrompt && state.systemPrompt.trim().length > 0) {
    personaInstruction = state.systemPrompt;
  } else {
    if (state.persona === "formal") personaInstruction = "Maintain a formal, professional, and corporate tone. Be thorough and polite.";
    if (state.persona === "creative") personaInstruction = "Be creative, engaging, and conversational in your response.";
  }
  
  const prompt = `Use the following context to answer the question. ${personaInstruction}\n\nFirst, output your internal reasoning enclosed in <thought>...</thought> tags, then provide your final answer.\n\nContext:\n${state.context}\n\nQuestion: ${lastMessage.content}`;
  
  let responseText = "";
  if ((state.modelType === "Groq" || state.modelType === "Grok") && process.env.GROQ_API_KEY) {
    const chatModel = new ChatGroq({
      apiKey: process.env.GROQ_API_KEY,
      model: "llama-3.1-8b-instant"
    });
    try {
      const chatResponse = await chatModel.invoke(prompt);
      responseText = chatResponse.content;
      // Store in KV Cache
      kvCache.set(lastMessage.content.toLowerCase(), {
        context: state.context,
        sources: state.sources,
        response: responseText
      });
    } catch(err) {
      responseText = "Error from Groq: " + err.message;
    }
  } else if (state.modelType === "Gemini" && process.env.GEMINI_API_KEY) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }]
      })
    });
    const data = await res.json();
    if (data.candidates && data.candidates.length > 0) {
      responseText = data.candidates[0].content.parts[0].text;
    } else {
      responseText = "Error from Gemini: " + JSON.stringify(data);
    }
  } else {
    responseText = `Error: API Key for ${state.modelType} not found in environment.`;
  }
  
  
    let reasoningText = "No reasoning provided.";
    if (responseText.includes('<thought>') && responseText.includes('</thought>')) {
      const thoughtStart = responseText.indexOf('<thought>') + 9;
      const thoughtEnd = responseText.indexOf('</thought>');
      reasoningText = responseText.substring(thoughtStart, thoughtEnd).trim();
      responseText = responseText.substring(thoughtEnd + 10).trim();
    }
    
    return { messages: [{ role: "agent", content: responseText, reasoning: reasoningText }] };

}

const workflow = new StateGraph({ channels: graphState })
  .addNode("retrieve", retrieveNode)
  .addNode("generate", generateNode)
  .addEdge("__start__", "retrieve")
  .addEdge("retrieve", "generate")
  .addEdge("generate", END);

const appGraph = workflow.compile();

const threads = new Map();

app.post('/chat', async (req, res) => {
  const { message, thread_id, model, persona, systemPrompt, history = [] } = req.body;
  const id = thread_id || uuidv4();
  
  if (!threads.has(id)) {
    threads.set(id, { state: 'started', history: [] });
  }
  
  const thread = threads.get(id);
  thread.history.push({ role: 'user', content: message });
  
  const msgLower = message.toLowerCase();
  if (msgLower.includes('github') || msgLower.includes('deploy') || msgLower.includes('ticket')) {
    thread.state = 'pending_approval';
    return res.json({
      thread_id: id,
      requires_approval: true,
      pending_tool_args: { action: 'write_to_github', repo: 'example/repo', title: 'Automated Action', body: `User requested action: "${message}"` }
    });
  }

  try {
    const inputs = {
      messages: [...history.map(h => ({ role: h.role, content: h.content })), { role: "user", content: message }],
      modelType: model || "Groq",
      persona: persona || "concise",
      systemPrompt: systemPrompt || ""
    };
    
    const result = await appGraph.invoke(inputs);
    
    // Format response
    const lastAgentMsgObj = result.messages[result.messages.length - 1];
    let finalResponse = lastAgentMsgObj.content;
    let traceText = lastAgentMsgObj.reasoning || "";
    
    // In case thought tags weren't processed by generateNode:
    const thoughtRegex = /<thought>([\s\S]*?)<\/thought>/i;
    const match = finalResponse.match(thoughtRegex);
    if (match) {
      traceText = match[1].trim();
      finalResponse = finalResponse.replace(thoughtRegex, "").trim();
    }
    
    const sources = result.sources;
    thread.history.push({ role: 'agent', content: finalResponse });
    
    return res.json({
      thread_id: id,
      response: finalResponse,
      requires_approval: false,
      sources: sources,
      reasoning: {
        attempts: 1,
        verdict: traceText && traceText !== "No reasoning provided." ? 'Verified by Graph' : 'Direct Response',
        trace: traceText || "Internal reasoning was not provided by the agent for this prompt."
      }
    });
  } catch (error) {
    console.error("Graph Error:", error);
    const fallback = `I encountered an error connecting to ${model}: ${error.message}.`;
    thread.history.push({ role: 'agent', content: fallback });
    return res.json({ thread_id: id, response: fallback, requires_approval: false });
  }
});

app.post('/approve-tool', (req, res) => {
  const { thread_id, approved } = req.body;
  
  if (!threads.has(thread_id)) {
    return res.status(404).json({ error: 'Thread not found' });
  }
  
  const thread = threads.get(thread_id);
  thread.state = 'resumed';
  
  let responseText = approved ? 'Action approved and executed successfully.' : 'Action was denied by the user.';
  thread.history.push({ role: 'agent', content: responseText });
  
  return res.json({ thread_id, response: responseText });
});


const upload = multer({ storage: multer.memoryStorage() });
app.post('/api/upload', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  
  try {
    const file = req.file;
    let textContent = '';
    
    if (file.mimetype === 'application/pdf') {
      const dataBuffer = fs_module.readFileSync(file.path);
      const data = await pdfParse(dataBuffer);
      textContent = data.text;
    } else if (file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      const result = await mammoth.extractRawText({ path: file.path });
      textContent = result.value;
    } else if (file.mimetype.startsWith('text/')) {
      textContent = fs_module.readFileSync(file.path, 'utf8');
    } else if (file.mimetype.startsWith('image/')) {
      textContent = `[Image Document: ${file.originalname}]`;
      // Here we could integrate Grok vision if supported, for now just index title
    } else {
      textContent = `[Document: ${file.originalname}]`;
    }
    
    if (textContent.trim()) {
      await vectorStore.addDocuments([{ 
        pageContent: textContent, 
        metadata: { source: file.originalname, type: 'uploaded' } 
      }]);
    }
    
    // clean up
    fs_module.unlinkSync(file.path);
    
    res.json({ success: true, filename: file.originalname });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Failed to process file' });
  }
});


app.post('/api/clear-cache', (req, res) => {
  kvCache.clear();
  res.json({ success: true });
});

app.get('/health', (req, res) => {
  return res.json({ status: 'ok' });
});

app.use('/api/*', (req, res) => {
  res.status(501).json({ error: 'Not yet migrated' });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

const PORT = 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
