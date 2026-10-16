// Ported from docs/design-system/illustrations/collaborators.svg: the drawing only. The frame, the defs
// and the dotted backdrop are Illustration's, and every colour comes from illustrations.css.

/**
 * Two machines joined by a line, with an eye on it: two teammates' Claudios connected directly, one
 * reading what the other shares. The node on the link is the one element in the brand gradient.
 */
export function Collaborators() {
  return (
    <>
      <rect x="20" y="48" width="72" height="48" rx="7" className="c1" />
      <rect x="30" y="60" width="34" height="5" rx="2.5" className="s3" /><rect x="30" y="71" width="24" height="5" rx="2.5" className="s3" /><rect x="30" y="82" width="40" height="5" rx="2.5" className="s3" />
      <path d="M12 100 H100 L94 107 H18 Z" className="c2" />
      <rect x="148" y="48" width="72" height="48" rx="7" className="c1" />
      <rect x="158" y="60" width="34" height="5" rx="2.5" className="s3" /><rect x="158" y="71" width="24" height="5" rx="2.5" className="s3" /><rect x="158" y="82" width="40" height="5" rx="2.5" className="s3" />
      <path d="M140 100 H228 L222 107 H146 Z" className="c2" />
      <path d="M92 72 H106 M134 72 H148" className="ln a-dash" />
      <circle cx="120" cy="72" r="14" className="cg" />
      <path d="M111 72 C114 66.5 126 66.5 129 72 C126 77.5 114 77.5 111 72 Z" className="ln-grad" />
      <circle cx="120" cy="72" r="2.5" className="f-accent" />
      <circle cx="56" cy="124" r="3" className="f-ink" /><circle cx="184" cy="124" r="3" className="f-ink" />
      <path d="M62 124 H178" className="ln-soft dash" />
    </>
  );
}
