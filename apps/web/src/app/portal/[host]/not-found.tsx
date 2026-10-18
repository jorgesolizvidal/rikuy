import { PORTAL_PATHS } from "@rikuy/core";

/** Inside a portal (its header and footer stay): a page that does not exist or is not public. */
export default function PortalNotFound() {
  return (
    <div className="portal-page">
      <h1 className="portal-page-title">No encontramos esta página</h1>
      <p className="portal-lead">
        Puede que la dirección esté mal escrita o que ya no esté publicada.
      </p>
      <p>
        <a href={PORTAL_PATHS.destinations}>Ver los destinos</a> · <a href="/">Ir al inicio</a>
      </p>
    </div>
  );
}
