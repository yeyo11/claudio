import { splitPath } from './review-model';

/**
 * A file path on one line. The directory and the file name are separate spans so the stylesheet can
 * cut the directory first: when the bar is narrow the name stays whole and the cut falls in the middle
 * of the path. The full path is the title (a span, not an interactive element).
 */
export function PathLabel({ path, className = '' }: { path: string; className?: string }) {
  const { dir, name } = splitPath(path);
  return (
    <span className={`changes-path ${className}`.trimEnd()} title={path}>
      {dir && <span className="changes-path-dir">{dir}/</span>}
      <span className="changes-path-name">{name}</span>
    </span>
  );
}
