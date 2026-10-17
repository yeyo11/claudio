import type { WorkItemDetail } from '@claudio/shared';
import { ChevronDown, Plus, X } from 'lucide-react';
import { useState, type ComponentPropsWithRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ICON_SM } from '@claudio/ui/components/icons';
import { EpicLabel, PriorityMark, WorkItemStatusIcon, WorkItemTypeIcon } from '../../../components/work-item-icons';
import { formatDateTime, timeAgo } from '@claudio/ui/lib/format';
import { columnMeta, priorityMeta } from '../../../lib/work-items';
import {
  AssigneeMark,
  MilestoneBar,
  NONE,
  assigneeOf,
  assigneeValue,
  useAssigneeName,
  useAssigneeOptions,
  useEpicOptions,
  useMilestoneOptions,
  usePriorityOptions,
  useStatusOptions,
  useTypeOptions,
} from './fields';
import { useMoveItem, type ItemActions } from './hooks';
import { addLabel } from './model';
import { Picker } from './Picker';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="prop-row" data-field={label}>
      <span className="prop-key">{label}</span>
      <span className="prop-value">{children}</span>
    </div>
  );
}

/**
 * The field a value button edits, said before the value off screen ("Assignee: Developer"), as the
 * New task form's fields say it. The button is named by what it shows, so a voice user can say the
 * words they see; an aria-label would hide them behind words of its own.
 */
export function FieldName({ field }: { field: string }) {
  return <span className="sr-only">{field}: </span>;
}

/**
 * The button a property is edited from: its value as the board draws it, and the chevron. The
 * picker's menu takes it as its trigger, so it passes on the props and the ref it is given.
 */
export function Value({
  children,
  field,
  chevron = false,
  className = '',
  ...rest
}: { children: ReactNode; field: string; chevron?: boolean; className?: string } & Omit<ComponentPropsWithRef<'button'>, 'children' | 'className'>) {
  return (
    <button type="button" {...rest} className={`prop-edit ${chevron ? 'btn btn-small' : ''} ${className}`.trim()}>
      <FieldName field={field} />
      {children}
      {chevron && <ChevronDown {...ICON_SM} />}
    </button>
  );
}

/** Free labels: each one a button that takes it off, and a field that adds one on Enter. */
export function LabelsEditor({ labels, onChange }: { labels: string[]; onChange: (labels: string[]) => void }) {
  const { t } = useTranslation('workItem');
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const commit = () => {
    const next = addLabel(labels, draft);
    if (next.length !== labels.length) onChange(next);
    setDraft('');
  };
  return (
    <span className="workitem-labels">
      {labels.map((label) => (
        <button
          key={label}
          type="button"
          className="workitem-label workitem-label-remove"
          aria-label={t('fields.removeLabel', { label })}
          onClick={() => onChange(labels.filter((l) => l !== label))}
        >
          {label}
          <X size={10} strokeWidth={2} aria-hidden />
        </button>
      ))}
      {adding ? (
        <input
          className="workitem-label-input"
          autoFocus
          value={draft}
          aria-label={t('fields.addLabel')}
          placeholder={t('fields.labelPlaceholder')}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            commit();
            setAdding(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              commit();
            } else if (e.key === 'Escape') {
              setDraft('');
              setAdding(false);
            }
          }}
        />
      ) : (
        <button type="button" className="icon-btn workitem-label-add" aria-label={t('fields.addLabel')} onClick={() => setAdding(true)}>
          <Plus {...ICON_SM} />
        </button>
      )}
    </span>
  );
}

/**
 * The properties of a work item, each edited where it is shown: the column, priority, type,
 * assignee, epic, milestone and labels, and when and by whom it was created. The right-hand column
 * of the page on a desktop, as the chat's inspector rows are.
 */
export function Properties({ item, actions, person }: { item: WorkItemDetail; actions: ItemActions; person: string }) {
  const { t } = useTranslation('workItem');
  const { t: tt } = useTranslation('tasks');
  const statuses = useStatusOptions();
  const move = useMoveItem(item, actions);
  const priorities = usePriorityOptions();
  const types = useTypeOptions(undefined, item.type);
  const assignees = useAssigneeOptions(person, item.assignee, item.projectId);
  const assigneeName = useAssigneeName(person)(item.assignee);
  const epics = useEpicOptions(item.projectId, item.id);
  const milestones = useMilestoneOptions(item.projectId, item.milestoneId);
  const milestone = milestones.milestones.find((m) => m.id === item.milestoneId) ?? null;
  const created = item.history.find((entry) => entry.change === 'created');
  const creator = created ? (created.actor.kind === 'person' ? person : t(`actor.${created.actor.kind}`)) : null;

  return (
    <section className="workitem-props" aria-label={t('props.label')}>
      <Row label={t('fields.status')}>
        <Picker
          label={t('fields.status')}
          value={item.status}
          options={statuses}
          onPick={move}
          trigger={
            <Value field={t('fields.status')} chevron>
              <WorkItemStatusIcon status={item.status} decorative />
              {tt(columnMeta(item.status).label)}
            </Value>
          }
        />
      </Row>
      <Row label={t('fields.priority')}>
        <Picker
          label={t('fields.priority')}
          value={item.priority}
          options={priorities}
          onPick={(priority) => actions.update.mutate({ priority })}
          trigger={
            <Value field={t('fields.priority')}>
              <PriorityMark priority={item.priority} />
              {tt(priorityMeta(item.priority).label)}
            </Value>
          }
        />
      </Row>
      <Row label={t('fields.type')}>
        <Picker
          label={t('fields.type')}
          value={item.type}
          options={types.map((option) =>
            // An item under an epic cannot become one: there is one level
            option.value === 'epic' && item.epicId ? { ...option, disabled: true, reason: t('fields.epicUnderEpic') } : option,
          )}
          onPick={(type) => actions.update.mutate({ type })}
          trigger={
            <Value field={t('fields.type')}>
              <WorkItemTypeIcon type={item.type} decorative />
              {tt(`type.${item.type}`)}
            </Value>
          }
        />
      </Row>
      <Row label={t('fields.assignee')}>
        <Picker
          label={t('fields.assignee')}
          value={assigneeValue(item.assignee)}
          options={assignees}
          onPick={(value) => actions.update.mutate({ assignee: assigneeOf(value) })}
          trigger={
            <Value field={t('fields.assignee')}>
              <AssigneeMark assignee={item.assignee} person={person} />
              <span className={item.assignee ? '' : 'muted'}>{assigneeName}</span>
            </Value>
          }
        />
      </Row>
      {item.type === 'epic' ? (
        <Row label={t('fields.children')}>
          <span className="small tnum">{t('fields.childrenCount', { count: item.children.length })}</span>
        </Row>
      ) : (
        <Row label={t('fields.epic')}>
          <Picker
            label={t('fields.epic')}
            value={item.epicId ?? NONE}
            options={epics.options}
            onPick={(value) => actions.update.mutate({ epicId: value === NONE ? null : value })}
            trigger={
              <Value field={t('fields.epic')}>
                {item.epic ? <EpicLabel epic={item.epic} /> : <span className="muted">{t('fields.noEpic')}</span>}
              </Value>
            }
          />
        </Row>
      )}
      <Row label={t('fields.milestone')}>
        <Picker
          label={t('fields.milestone')}
          value={item.milestoneId ?? NONE}
          options={milestones.options}
          onPick={(value) => actions.update.mutate({ milestoneId: value === NONE ? null : value })}
          trigger={
            <Value field={t('fields.milestone')}>
              {milestone ? (
                <>
                  <span className="milestone-name">{milestone.name}</span>
                  <MilestoneBar milestone={milestone} />
                </>
              ) : (
                <span className="muted">{t('fields.noMilestone')}</span>
              )}
            </Value>
          }
        />
      </Row>
      <Row label={t('fields.labels')}>
        <LabelsEditor labels={item.labels} onChange={(labels) => actions.update.mutate({ labels })} />
      </Row>
      <Row label={t('fields.created')}>
        <span className="small tnum prop-fact" title={formatDateTime(item.createdAt)}>
          {creator ? t('fields.createdBy', { when: timeAgo(item.createdAt), who: creator }) : timeAgo(item.createdAt)}
        </span>
      </Row>
    </section>
  );
}
