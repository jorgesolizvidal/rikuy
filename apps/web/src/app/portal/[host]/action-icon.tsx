/**
 * The icons of the actions in «Para tu visita» (ADR-068): decorative, the button's text is
 * its name. Outline paths on a 24-unit grid, in the button's color.
 */
const PATHS = {
  directions:
    "M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0C18.5 15.4 12 21 12 21Zm0-8.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z",
  tour: "M3 12c0-2.2 4-4 9-4s9 1.8 9 4-4 4-9 4M8.5 15.6 12 16l-2.6 2.6M12 8V4",
  share:
    "M18 8a3 3 0 1 0-2.8-4M6 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm12 6a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM8.6 13.5l6.8 4M15.4 6.5l-6.8 4",
  calendar: "M5 6h14v14H5zM5 10h14M9 4v4M15 4v4",
  phone:
    "M6.6 3.5h2.8l1.4 4-2 1.3a11 11 0 0 0 6.4 6.4l1.3-2 4 1.4v2.8A2 2 0 0 1 18.4 20 15 15 0 0 1 4 5.6a2 2 0 0 1 2.6-2.1Z",
  message: "M4 19.5 5.3 16A8 8 0 1 1 8 18.7L4 19.5ZM9 10h6M9 13h4",
} as const;

export type ActionIconName = keyof typeof PATHS;

export function ActionIcon({ name }: { readonly name: ActionIconName }) {
  return (
    <svg
      className="portal-action-icon"
      aria-hidden="true"
      viewBox="0 0 24 24"
      width="18"
      height="18"
      focusable="false"
    >
      <path
        d={PATHS[name]}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
