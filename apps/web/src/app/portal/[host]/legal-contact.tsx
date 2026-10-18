import type { TenantPresentation } from "@rikuy/core";

/** How to reach the municipality, from its published contact data. */
export function LegalContact({ presentation }: { readonly presentation: TenantPresentation }) {
  const { contact, identity } = presentation;
  const channels = [
    contact.email ? (
      <a key="email" href={`mailto:${contact.email}`}>
        {contact.email}
      </a>
    ) : null,
    contact.phone ? (
      <a key="phone" href={`tel:${contact.phone.replace(/[^\d+]/g, "")}`}>
        {contact.phone}
      </a>
    ) : null,
    contact.address ? <span key="address">{contact.address}</span> : null,
  ].filter((channel) => channel !== null);

  if (channels.length === 0) {
    return <p>Puedes comunicarte con {identity.siteName} por sus canales oficiales de atención.</p>;
  }
  return (
    <p>
      Puedes comunicarte con {identity.siteName} en:{" "}
      {channels.map((channel, index) => (
        <span key={index}>
          {index > 0 ? " · " : null}
          {channel}
        </span>
      ))}
      .
    </p>
  );
}
