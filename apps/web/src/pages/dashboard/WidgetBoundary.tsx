import { Component, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ErrorBox } from '@claudio/ui/components/ui';
import { isChunkLoadError, noticeStaleChunk } from '../../lib/reload';

/**
 * What a widget shows in place of itself. A chunk that is gone is not a bug in the widget: the page
 * outlived an update, so it says so in the person's language (the banner above offers the reload)
 * and never prints the browser's own English message.
 */
export function WidgetFailure({ title, error }: { title: string; error: unknown }) {
  const { t } = useTranslation(['home', 'shell']);
  const heading = t('home:dashboard.widgetFailed', { title });
  return <ErrorBox error={isChunkLoadError(error) ? t('shell:reload.stalePageHint') : error} title={heading} />;
}

/** One widget failing to render (or to load its chunk) takes its own cell down, not the dashboard. */
export class WidgetBoundary extends Component<{ title: string; children: ReactNode }, { error: unknown }> {
  state = { error: null as unknown };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  componentDidCatch(error: unknown) {
    // A side effect, so it lives here and not in render: the offer is what turns the cell's message into a Reload
    if (isChunkLoadError(error)) noticeStaleChunk();
  }

  render() {
    return this.state.error ? <WidgetFailure title={this.props.title} error={this.state.error} /> : this.props.children;
  }
}
