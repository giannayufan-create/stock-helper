import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
    children: ReactNode;
}

interface State {
    error: Error | null;
}

/** Keep the shell usable if a panel (e.g. chart) throws while loading a symbol. */
export class ErrorBoundary extends Component<Props, State> {
    state: State = { error: null };

    static getDerivedStateFromError(error: Error): State {
        return { error };
    }

    componentDidCatch(error: Error, info: ErrorInfo) {
        console.error('[ErrorBoundary]', error, info.componentStack);
    }

    render() {
        if (this.state.error) {
            return (
                <div
                    style={{
                        padding: '2rem',
                        color: '#f0f2f5',
                        background: '#0b0d10',
                        minHeight: '100vh',
                        fontFamily: 'system-ui, sans-serif',
                    }}
                >
                    <h2 style={{ marginTop: 0 }}>畫面出錯了</h2>
                    <p style={{ color: '#8b93a0' }}>
                        {this.state.error.message}
                    </p>
                    <button
                        type="button"
                        onClick={() => {
                            this.setState({ error: null });
                            const u = new URL(window.location.href);
                            u.searchParams.set('_r', String(Date.now()));
                            window.location.replace(u.toString());
                        }}
                        style={{
                            marginTop: '1rem',
                            padding: '8px 14px',
                            background: '#e8b84a',
                            border: 'none',
                            borderRadius: 6,
                            cursor: 'pointer',
                            fontWeight: 700,
                        }}
                    >
                        重新整理
                    </button>
                </div>
            );
        }
        return this.props.children;
    }
}
