"""
A real, live-API tool — filing a GitHub issue — used to demonstrate tool
calling against an actual external system rather than a mocked function.
The write action itself is never executed by this module directly from
graph logic; the graph's `interrupt_before` gate (see graph/build_graph.py)
pauses before this runs and waits for explicit human approval. This module
only performs the actual API call once approval has already happened.
"""
from github import Github

from app.config import settings
from app.schemas import GitHubIssueArgs


def create_github_issue(args: GitHubIssueArgs) -> str:
    """Executes the write action. Only ever called after human approval."""
    gh = Github(settings.github_token)
    repo = gh.get_repo(settings.github_repo)
    issue = repo.create_issue(title=args.title, body=args.body, labels=args.labels)
    return issue.html_url
