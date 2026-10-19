// Ported from docs/design-system/illustrations/claudio.svg: the drawing only. The frame, the defs
// and the dotted backdrop are Illustration's, and every colour comes from illustrations.css.
// The C is the logo's own path, scaled uniformly by 1.1 and drawn after the body so its lower arm
// hides the body's foot; `.cut` separates the two with a gap in the page's background.
export function Claudio() {
  return (
    <>
      <ellipse cx="94" cy="141" rx="54" ry="5" className="ln-soft" />
      <g className="a-float">
        <rect x="83" y="74" width="32" height="54" rx="9" className="f-spark" />
        <g className="a-look">
          <ellipse cx="100.5" cy="90" rx="2.6" ry="3.6" className="f-eye" />
          <ellipse cx="109.5" cy="90" rx="2.6" ry="3.6" className="f-eye" />
        </g>
      </g>
      <path
        transform="translate(31 14) scale(1.1)"
        className="f-logo cut"
        d="M41.76 14.24Q46 10 52 10L71 10Q74 10 76.12 12.12L93.88 29.88Q96 32 93 32L57 32Q54 32 51.88 34.12L34.83 51.17Q32 54 32 58L32 62Q32 66 34.83 68.83L51.88 85.88Q54 88 57 88L93 88Q96 88 93.88 90.12L76.12 107.88Q74 110 71 110L52 110Q46 110 41.76 105.76L14.24 78.24Q10 74 10 68L10 52Q10 46 14.24 41.76Z"
      />
      <g className="a-float-2">
        <path transform="translate(97 59) scale(0.4)" className="f-spark" d="M0 -19Q6 -6 19 0Q6 6 0 19Q-6 6 -19 0Q-6 -6 0 -19Z" />
      </g>
      <g className="a-float-2">
        <rect x="146" y="56" width="48" height="26" rx="13" className="c2" />
        <text x="158" y="73.5" className="txt-big">›</text>
        <rect x="168" y="63" width="7" height="12" rx="1.5" className="f-ink a-blink" />
      </g>
    </>
  );
}
