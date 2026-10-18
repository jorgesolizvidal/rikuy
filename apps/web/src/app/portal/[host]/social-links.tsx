import type { TenantPresentation } from "@rikuy/core";

import { SOCIAL_LABELS } from "@/lib/social-labels";

export function SocialLinks({ links }: { readonly links: TenantPresentation["social"] }) {
  return (
    <ul className="portal-social">
      {links.map((link) => (
        <li key={link.network}>
          {/* Validated https URLs only; external links never get the opener. */}
          <a href={link.url} rel="noopener noreferrer external" target="_blank">
            {SOCIAL_LABELS[link.network]}
            <span className="visually-hidden"> (se abre en otra pestaña)</span>
          </a>
        </li>
      ))}
    </ul>
  );
}
