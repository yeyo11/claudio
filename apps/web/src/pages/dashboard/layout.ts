/**
 * A dashboard's layout is data, not markup: a list of widgets by type, size and config. The rules
 * for what a stored layout may contain live in `@claudio/shared`, so the API that stores it and the
 * page that draws it read the same ones; this file re-exports them where the dashboard's code
 * already imports them from.
 */
export {
  fitsScope,
  layoutOf,
  validateLayout,
  WIDGET_SIZES,
  type DashboardLayout,
  type DashboardScope,
  type LayoutWidget,
  type WidgetRule,
  type WidgetScope,
  type WidgetSize,
} from '@claudio/shared';

/** A number from a widget's config, or the fallback when it is missing or not a sane count. */
export function configCount(config: Record<string, unknown> | undefined, key: string, fallback: number, max = 50): number {
  const value = config?.[key];
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? Math.min(value, max) : fallback;
}
