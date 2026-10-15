import { baseKeymap, splitBlock } from 'prosemirror-commands';
import { history, redo, undo } from 'prosemirror-history';
import { keymap } from 'prosemirror-keymap';
import { EditorState, Plugin, TextSelection, type Transaction } from 'prosemirror-state';
import { Decoration, DecorationSet, EditorView } from 'prosemirror-view';
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import { docFromText, offsetOfPos, plainSlice, posOfOffset, schema, textOf } from './text';

/**
 * Which key sends. `enter`: Enter sends and Shift+Enter breaks the line, for a keyboard. `mod-enter`:
 * Enter breaks the line and Ctrl/⌘+Enter sends, for a touch screen (whose keyboard has no Shift+Enter
 * worth the name) and for a first message that is usually long.
 */
export type SubmitKey = 'enter' | 'mod-enter';

/** What the composer does with the box: it holds the text, the box tells it what changed. */
export interface RichEditorHandle {
  focus(): void;
  getText(): string;
  /** Replaces the whole text; the caret goes to `caret` (an offset into the text), or the end */
  setText(text: string, caret?: number): void;
  /** Where the caret is, as an offset into the text */
  getCaret(): number;
  setCaret(offset: number): void;
  /** Inserts at the caret, replacing what is selected */
  insertText(text: string): void;
  readonly element: HTMLElement | null;
}

export interface RichEditorProps {
  initialText?: string;
  placeholder: string;
  ariaLabel: string;
  /** Extra attributes of the box itself: what a list it drives (the slash menu) tells assistive tech */
  ariaProps?: Record<string, string | undefined>;
  submitKey: SubmitKey;
  disabled?: boolean;
  autoFocus?: boolean;
  className?: string;
  onChange(text: string): void;
  onCaret?(offset: number): void;
  onSubmit(): void;
  /** Runs before the box's own keys; true when the key was taken (the slash menu, history, Escape) */
  onKeyDown?(event: KeyboardEvent): boolean;
  /** Files pasted into the box: they are attachments, not text */
  onPasteFiles?(files: File[]): void;
  /** A paste longer than `bigPasteChars`: the composer may attach it as a file instead */
  onBigPaste?(text: string): boolean;
  bigPasteChars?: number;
}

const isMac = typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/.test(navigator.platform);

/**
 * The message box: a ProseMirror view over plain paragraphs. Over a textarea it brings what a chat's
 * box needs and a textarea fights: composition (IME, dead keys) that is never cut by Enter, an undo
 * history of its own, pasted rich text reduced to the words, a height the stylesheet sets with no
 * measuring on each keystroke, and room for inline chips later. The text, not the document, is what
 * leaves it: the composer reads and writes strings, and nothing it sends depends on ProseMirror.
 */
export const RichEditor = forwardRef<RichEditorHandle, RichEditorProps>(function RichEditor(props, ref) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  // The view is made once; what it calls back reads the props of the latest render
  const latest = useRef(props);
  latest.current = props;

  useLayoutEffect(() => {
    const mount = host.current;
    if (!mount) return;
    const placeholder = new Plugin({
      props: {
        decorations: (state) => {
          const { doc } = state;
          const first = doc.firstChild;
          if (doc.childCount !== 1 || !first || first.content.size > 0) return null;
          return DecorationSet.create(doc, [Decoration.node(0, first.nodeSize, { class: 'is-empty', 'data-placeholder': latest.current.placeholder })]);
        },
      },
    });
    const keys = keymap({
      'Mod-z': undo,
      'Shift-Mod-z': redo,
      ...(isMac ? {} : { 'Mod-y': redo }),
      'Shift-Enter': splitBlock,
    });
    const state = EditorState.create({ schema, doc: docFromText(latest.current.initialText ?? ''), plugins: [history(), keys, keymap(baseKeymap), placeholder] });
    const editor = new EditorView(
      { mount },
      {
        state,
        attributes: attributesOf(latest.current),
        editable: () => !latest.current.disabled,
        handleKeyDown: (v, event) => {
          // A composition in progress ends with Enter: that Enter picks the word, it never sends.
          // 229 is what some browsers report for every key of a composition
          if (event.isComposing || v.composing || event.keyCode === 229) return false;
          const p = latest.current;
          if (p.onKeyDown?.(event)) {
            event.preventDefault();
            return true;
          }
          if (event.key !== 'Enter' || event.altKey) return false;
          const mod = isMac ? event.metaKey : event.ctrlKey;
          const sends = mod || (p.submitKey === 'enter' && !event.shiftKey);
          if (!sends) return false;
          event.preventDefault();
          p.onSubmit();
          return true;
        },
        handlePaste: (v, event) => {
          const data = event.clipboardData;
          if (!data) return false;
          const files = [...data.files];
          if (files.length > 0 && latest.current.onPasteFiles) {
            latest.current.onPasteFiles(files);
            return true;
          }
          // Only the words: styles, links and tables pasted from a page are not a message
          const text = data.getData('text/plain');
          if (!text) return true;
          const { bigPasteChars = Number.POSITIVE_INFINITY, onBigPaste } = latest.current;
          if (text.length > bigPasteChars && onBigPaste?.(text)) return true;
          v.dispatch(v.state.tr.replaceSelection(plainSlice(text)).scrollIntoView());
          return true;
        },
        // Files dropped on the box are the composer's (its drop zone attaches them): not text to insert
        handleDrop: (_v, event) => Boolean(event.dataTransfer?.files.length),
        dispatchTransaction(this: EditorView, tr: Transaction) {
          const before = this.state;
          const next = before.apply(tr);
          this.updateState(next);
          if (tr.docChanged) latest.current.onChange(textOf(next.doc));
          if (tr.docChanged || !before.selection.eq(next.selection)) latest.current.onCaret?.(offsetOfPos(next.doc, next.selection.head));
        },
      },
    );
    view.current = editor;
    if (latest.current.autoFocus) editor.focus();
    return () => {
      editor.destroy();
      view.current = null;
    };
  }, []);

  // The label, the placeholder and what the slash menu says change with the chat's state
  const { placeholder, ariaLabel, ariaProps, disabled, className } = props;
  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    editor.setProps({ attributes: attributesOf(latest.current) });
    // The placeholder is a decoration: a state update draws it again
    editor.updateState(editor.state);
  }, [placeholder, ariaLabel, JSON.stringify(ariaProps), disabled, className]);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => view.current?.focus(),
      getText: () => (view.current ? textOf(view.current.state.doc) : ''),
      setText: (text, caret) => {
        const editor = view.current;
        if (!editor) return;
        const doc = docFromText(text);
        const tr = editor.state.tr.replaceWith(0, editor.state.doc.content.size, doc.content);
        const at = posOfOffset(tr.doc, caret ?? text.length);
        editor.dispatch(tr.setSelection(TextSelection.create(tr.doc, at)).scrollIntoView());
      },
      getCaret: () => (view.current ? offsetOfPos(view.current.state.doc, view.current.state.selection.head) : 0),
      setCaret: (offset) => {
        const editor = view.current;
        if (!editor) return;
        const at = posOfOffset(editor.state.doc, offset);
        editor.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, at)).scrollIntoView());
      },
      insertText: (text) => {
        const editor = view.current;
        if (!editor) return;
        editor.dispatch(editor.state.tr.replaceSelection(plainSlice(text)).scrollIntoView());
      },
      get element() {
        return view.current?.dom ?? null;
      },
    }),
    [],
  );

  return <div ref={host} className="composer-editor" />;
});

function attributesOf(props: RichEditorProps): Record<string, string> {
  const attributes: Record<string, string> = {
    role: 'textbox',
    'aria-multiline': 'true',
    'aria-label': props.ariaLabel,
    'aria-placeholder': props.placeholder,
    class: `composer-input ${props.className ?? ''}`.trim(),
    spellcheck: 'true',
    autocapitalize: 'sentences',
    // Read by the e2e driver and by assistive tech: the box's text without the decorations
    'data-composer-input': '',
  };
  if (props.disabled) attributes['aria-disabled'] = 'true';
  for (const [name, value] of Object.entries(props.ariaProps ?? {})) if (value !== undefined) attributes[name] = value;
  return attributes;
}
