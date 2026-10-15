import type { Project, ProjectDoc } from '@claudio/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, FilePlus, Link2, MessageSquare, RefreshCw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { api, keys, useConnectors, useProjectDocs } from '../../api';
import { MoreActions, type MenuEntry } from '@claudio/ui/components/controls';
import { Dialog, useConfirm } from '@claudio/ui/components/Dialog';
import { ICON_SM } from '@claudio/ui/components/icons';
import { useToast } from '@claudio/ui/components/Toast';
import { Empty, ErrorBox, Skeleton } from '@claudio/ui/components/ui';
import { formatNumber, timeAgo } from '@claudio/ui/lib/format';
import { queryView } from '../../lib/query-view';

const STATUS_BADGE = { unread: 'badge-idle', ok: 'badge-ok', unavailable: 'badge-warn' } as const;

/** The title is the link to the document on claude.ai; Claudio opens it, it does not render it. */
function DocRow({ doc, onAsk, onRemove, busy }: { doc: ProjectDoc; onAsk: () => void; onRemove: () => void; busy: boolean }) {
  const { t } = useTranslation('documents');
  const entries: MenuEntry[] = [
    { id: 'ask', label: t('claudeDocs.ask'), icon: MessageSquare, onSelect: onAsk, disabled: busy },
    { id: 'open', label: t('claudeDocs.open'), icon: ExternalLink, onSelect: () => window.open(doc.url, '_blank', 'noopener,noreferrer') },
    { id: 'remove', label: t('claudeDocs.remove'), icon: Trash2, onSelect: onRemove, destructive: true },
  ];
  return (
    <li className="cdoc-row">
      <span className="doc-row-main">
        <a className="doc-row-title" href={doc.url} target="_blank" rel="noopener noreferrer">
          {doc.title}
        </a>
        <span className="doc-row-meta">
          <span className="mono ellipsis">{doc.id}</span>
          <span>{t(`claudeDocs.by.${doc.createdBy}`)}</span>
          {doc.checkedAt && <span>{t('claudeDocs.checked', { when: timeAgo(doc.checkedAt) })}</span>}
        </span>
      </span>
      <span className={`badge ${STATUS_BADGE[doc.status]}`}>
        <span className="badge-text">{t(`claudeDocs.status.${doc.status}`)}</span>
      </span>
      <button type="button" className="btn btn-small cdoc-ask" disabled={busy} onClick={onAsk}>
        <MessageSquare {...ICON_SM} />
        {t('claudeDocs.ask')}
      </button>
      <MoreActions entries={entries} label={t('claudeDocs.more')} />
    </li>
  );
}

/** Adds a document by its link, or has a confined session create one: both can take a while, so the dialog waits on the server. */
function AddDialog({ project, mode, onClose }: { project: Project; mode: 'link' | 'create'; onClose: () => void }) {
  const { t } = useTranslation(['documents', 'common']);
  const qc = useQueryClient();
  const toast = useToast();
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const link = mode === 'link';
  const add = useMutation({
    mutationFn: () => api.addProjectDoc(project.id, link ? { url: url.trim() } : { create: { title: title.trim(), body: body.trim() } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.projectDocs(project.id) });
      onClose();
    },
    onError: (error) => toast.error(t('documents:claudeDocs.addFailed'), error),
  });
  const ready = (link ? url.trim() !== '' : title.trim() !== '') && !add.isPending;
  return (
    <Dialog
      title={t(link ? 'documents:claudeDocs.addTitle' : 'documents:claudeDocs.newTitle')}
      onClose={onClose}
      width={520}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={add.isPending}>
            {t('common:actions.cancel')}
          </button>
          <button type="button" className="btn btn-primary" disabled={!ready} onClick={() => add.mutate()}>
            {add.isPending ? t(link ? 'documents:claudeDocs.adding' : 'documents:claudeDocs.creating') : t(link ? 'documents:claudeDocs.addSubmit' : 'documents:claudeDocs.create')}
          </button>
        </>
      }
    >
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) add.mutate();
        }}
      >
        {link ? (
          <label className="field">
            <span className="field-label">{t('documents:claudeDocs.urlLabel')}</span>
            <input data-autofocus className="mono" value={url} placeholder={t('documents:claudeDocs.urlPlaceholder')} onChange={(e) => setUrl(e.target.value)} />
            <span className="field-hint">{t('documents:claudeDocs.addHint')}</span>
          </label>
        ) : (
          <>
            <label className="field">
              <span className="field-label">{t('documents:claudeDocs.titleLabel')}</span>
              <input data-autofocus value={title} onChange={(e) => setTitle(e.target.value)} />
            </label>
            <label className="field">
              <span className="field-label">{t('documents:claudeDocs.bodyLabel')}</span>
              <textarea rows={5} value={body} onChange={(e) => setBody(e.target.value)} />
              <span className="field-hint">{t('documents:claudeDocs.bodyHint')}</span>
            </label>
          </>
        )}
      </form>
    </Dialog>
  );
}

/**
 * The project's Claude Docs: a registry of ids and links, because the connector cannot list an
 * account. Hidden while the CLI has not answered or does not list the Docs connector, and a note
 * that says where to connect it while it needs authorisation.
 */
export function ClaudeDocsCard({ project }: { project: Project }) {
  const { t } = useTranslation('documents');
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const connectors = useConnectors();
  const [adding, setAdding] = useState<'link' | 'create' | null>(null);
  const docsConnector = connectors.data?.connectors.find((c) => c.kind === 'docs');
  const connected = docsConnector?.status === 'connected';
  // The registry is read from the store, but a card that is not drawn has no reason to ask for it
  const docs = useProjectDocs(project.id, connected);

  const refresh = useMutation({
    mutationFn: () => api.refreshProjectDocs(project.id),
    onSuccess: (overview) => qc.setQueryData(keys.projectDocs(project.id), overview),
    onError: (error) => toast.error(t('claudeDocs.refreshFailed'), error),
  });
  const remove = useMutation({
    mutationFn: (doc: ProjectDoc) => api.removeProjectDoc(project.id, doc.id),
    onSuccess: (_void, doc) => {
      void qc.invalidateQueries({ queryKey: keys.projectDocs(project.id) });
      toast.success(t('claudeDocs.removed', { title: doc.title }));
    },
    onError: (error) => toast.error(t('claudeDocs.removeFailed'), error),
  });
  const ask = useMutation({
    mutationFn: (doc: ProjectDoc) => api.askProjectDoc(project.id, doc.id),
    onSuccess: (chat) => navigate(`/chats/${encodeURIComponent(chat.id)}`),
    onError: (error) => toast.error(t('claudeDocs.askFailed'), error),
  });

  if (!docsConnector) return null;
  if (!connected) {
    return (
      <section className="card cdoc" aria-labelledby="cdoc-title">
        <div className="card-head">
          <h2 id="cdoc-title">{t('claudeDocs.title')}</h2>
        </div>
        <p className="small muted doc-card-note">{t('claudeDocs.connectHint')}</p>
        <div className="doc-new-actions">
          <Link className="btn btn-small" to="/connectors">
            {t('claudeDocs.connectLink')}
          </Link>
        </div>
      </section>
    );
  }

  const view = queryView(docs);
  const list = docs.data?.docs ?? [];
  const onRemove = async (doc: ProjectDoc) => {
    const ok = await confirm({ title: t('claudeDocs.removeTitle', { title: doc.title }), body: t('claudeDocs.removeBody'), confirmLabel: t('claudeDocs.removeConfirm'), danger: true });
    if (ok) remove.mutate(doc);
  };

  return (
    <section className="card cdoc" aria-labelledby="cdoc-title">
      <div className="card-head">
        <h2 id="cdoc-title">{t('claudeDocs.title')}</h2>
        <span className="count">{formatNumber(list.length)}</span>
        <span className="cdoc-actions">
          <button type="button" className="btn btn-small" onClick={() => setAdding('link')}>
            <Link2 {...ICON_SM} />
            {t('claudeDocs.add')}
          </button>
          <button type="button" className="btn btn-small" onClick={() => setAdding('create')}>
            <FilePlus {...ICON_SM} />
            {t('claudeDocs.new')}
          </button>
          <button type="button" className="btn btn-small doc-quiet" disabled={refresh.isPending || list.length === 0} onClick={() => refresh.mutate()}>
            <RefreshCw {...ICON_SM} />
            {refresh.isPending ? t('claudeDocs.refreshing') : t('claudeDocs.refresh')}
          </button>
        </span>
      </div>
      {view === 'loading' ? (
        <div className="doc-card-note">
          <Skeleton rows={2} height={18} />
        </div>
      ) : view !== 'shown' ? (
        <ErrorBox error={docs.error} title={t('claudeDocs.loadFailed')} />
      ) : list.length === 0 ? (
        <Empty illustration="connector" size="sm" title={t('claudeDocs.emptyTitle')}>
          {t('claudeDocs.emptyHint')}
        </Empty>
      ) : (
        <ul className="doc-rows">
          {list.map((doc) => (
            <DocRow key={doc.id} doc={doc} busy={ask.isPending} onAsk={() => ask.mutate(doc)} onRemove={() => void onRemove(doc)} />
          ))}
        </ul>
      )}
      {adding && <AddDialog project={project} mode={adding} onClose={() => setAdding(null)} />}
    </section>
  );
}
