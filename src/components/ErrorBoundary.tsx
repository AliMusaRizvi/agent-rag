import React from 'react';
import { AlertTriangle } from 'lucide-react';

interface State {
  hasError: boolean;
  message?: string;
}

// Nothing upstream of this used to exist — a corrupted localStorage value,
// a component-level render error, anything at all threw straight past
// React with no recovery UI, taking the whole app down to a blank page.
export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, message: error.message };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('Unhandled UI error:', error, info);
  }

  handleReset = () => {
    try {
      localStorage.clear();
    } catch {
      // ignore — storage may already be unavailable
    }
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-screen w-screen items-center justify-center bg-background text-textMain p-6">
          <div className="max-w-sm text-center flex flex-col items-center gap-4">
            <AlertTriangle className="text-warning" size={32} />
            <div>
              <h1 className="font-semibold text-lg mb-1">Something went wrong</h1>
              <p className="text-sm text-textMuted">
                The app hit an unexpected error{this.state.message ? `: ${this.state.message}` : '.'} Resetting local
                data usually fixes it.
              </p>
            </div>
            <button
              onClick={this.handleReset}
              className="px-4 py-2 bg-primary hover:bg-primaryHover text-white text-sm font-medium rounded-lg transition-colors"
            >
              Reset and reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
