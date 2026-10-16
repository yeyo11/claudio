// Ported from docs/design-system/illustrations/evals.svg: the drawing only. The frame, the defs
// and the dotted backdrop are Illustration's, and every colour comes from illustrations.css.

/** The three tool calls an eval expects, each a row under the prompt: two ticks and a failed one. */
const ROWS = [
  { y: 82, bar: 54, ok: true },
  { y: 98, bar: 38, ok: true },
  { y: 114, bar: 62, ok: false },
] as const;

/**
 * A prompt card over three tool-call ticks, the last one failed: what an eval checks, call by call.
 * The prompt card carries the gradient and floats; nothing here is a button.
 */
export function Evals() {
  return (
    <>
      <rect x="62" y="70" width="116" height="62" rx="9" className="c1" />
      {ROWS.map(({ y, bar, ok }) => (
        <g key={y}>
          {ok ? <path d={`M74 ${y} l3 3 l6 -6.5`} className="ln-ok" /> : <path d={`M74.5 ${y - 4} l8 8 M82.5 ${y - 4} l-8 8`} className="ln-bad" />}
          <rect x="92" y={y - 2} width={bar} height="4" rx="2" className={ok ? 's3' : 'f-bad-soft'} />
        </g>
      ))}
      <g className="a-float">
        <rect x="46" y="24" width="148" height="38" rx="9" className="cg" />
        <text x="58" y="40" className="txt">$ prompt</text>
        <rect x="58" y="47" width="86" height="4" rx="2" className="s3" />
        <rect x="150" y="47" width="30" height="4" rx="2" className="s3" />
      </g>
    </>
  );
}
