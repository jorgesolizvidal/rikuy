"use client";

import { suggestSlug, type ProvisionField } from "@rikuy/core";
import Link from "next/link";
import {
  useActionState,
  useEffect,
  useRef,
  useState,
  useTransition,
  type FormEvent,
  type ReactNode,
} from "react";

import { provisionTenantAction, type ProvisionState } from "../actions";

const FIELD_ERRORS: Readonly<Record<ProvisionField, string>> = {
  displayName: "Escribe el nombre del municipio (hasta 120 caracteres).",
  slug: "Usa minúsculas, números y guiones, sin espacios ni tildes. Algunos nombres están reservados (app, www, admin…).",
  hostname:
    "Escribe solo el dominio, sin http:// ni puerto, y distinto al del panel y al de la plataforma.",
  ownerEmail: "Escribe un correo válido.",
};

const STATUS_MESSAGES: Partial<Record<ProvisionState["status"], string>> = {
  invalid_input: "Revisa los campos marcados.",
  slug_taken: "Ya existe un municipio con ese identificador.",
  hostname_taken: "Esa dirección ya la usa otro municipio.",
  owner_not_found: "No se pudo preparar la cuenta del propietario. Inténtalo de nuevo.",
  invalid: "La base de datos rechazó los datos. Revisa el identificador y la dirección.",
  forbidden: "Tu sesión de operador ya no es válida. Recarga la página.",
  error: "No se pudo dar de alta el municipio. Inténtalo de nuevo en unos segundos.",
};

export function ProvisionForm({
  rootDomain,
  adminOrigin,
}: {
  readonly rootDomain: string;
  readonly adminOrigin: string;
}) {
  const [state, dispatch, pending] = useActionState(provisionTenantAction, {
    status: "idle",
  } as ProvisionState);
  const [, startTransition] = useTransition();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [hostname, setHostname] = useState("");
  const [email, setEmail] = useState("");
  const edited = useRef({ slug: false, hostname: false });
  const formRef = useRef<HTMLFormElement>(null);

  const fields = new Set(state.fields ?? []);
  const errorFor = (field: ProvisionField) => (fields.has(field) ? FIELD_ERRORS[field] : null);

  useEffect(() => {
    if (state.status === "invalid_input")
      formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [state]);

  function onName(value: string) {
    setName(value);
    if (!edited.current.slug) onSlug(suggestSlug(value), false);
  }

  function onSlug(value: string, byUser = true) {
    if (byUser) edited.current.slug = true;
    setSlug(value);
    if (!edited.current.hostname) setHostname(value ? `${value}.${rootDomain}` : "");
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(() => dispatch(formData));
  }

  if (state.status === "provisioned") {
    return (
      <div className="form" role="status">
        <p className="notice">
          Municipio creado en preparación. Se invitó a <strong>{state.ownerEmail}</strong> como
          propietario.
        </p>
        <p>
          Pídele que entre en <strong>{adminOrigin}</strong> con ese correo, reciba su código y
          acepte la invitación. Después podrás ponerlo en línea desde la lista de municipios; su
          portal será <strong>{state.portalUrl}</strong>.
        </p>
        <div className="form-actions">
          <Link href="/plataforma" className="button">
            Ir a la lista de municipios
          </Link>
        </div>
      </div>
    );
  }

  return (
    <form ref={formRef} className="form" onSubmit={submit} noValidate>
      <Field
        id="displayName"
        label="Nombre del municipio"
        hint="Como aparecerá en el portal y en el panel."
        error={errorFor("displayName")}
      >
        <input
          id="displayName"
          name="displayName"
          value={name}
          maxLength={120}
          required
          onChange={(e) => onName(e.target.value)}
          {...invalidProps("displayName", errorFor("displayName"))}
        />
      </Field>
      <Field
        id="slug"
        label="Identificador"
        hint="Se usa en direcciones internas. No se puede cambiar después."
        error={errorFor("slug")}
      >
        <input
          id="slug"
          name="slug"
          value={slug}
          maxLength={63}
          required
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => onSlug(e.target.value)}
          {...invalidProps("slug", errorFor("slug"))}
        />
      </Field>
      <Field
        id="hostname"
        label="Dirección del portal"
        hint={`Por defecto, un subdominio de ${rootDomain}. También puede ser un alias exacto como municipio.vercel.app.`}
        error={errorFor("hostname")}
      >
        <input
          id="hostname"
          name="hostname"
          value={hostname}
          maxLength={253}
          required
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => {
            edited.current.hostname = true;
            setHostname(e.target.value);
          }}
          {...invalidProps("hostname", errorFor("hostname"))}
        />
      </Field>
      <Field
        id="ownerEmail"
        label="Correo del propietario"
        hint="Recibirá acceso al panel para administrar el municipio."
        error={errorFor("ownerEmail")}
      >
        <input
          id="ownerEmail"
          name="ownerEmail"
          type="email"
          value={email}
          maxLength={254}
          required
          autoComplete="off"
          onChange={(e) => setEmail(e.target.value)}
          {...invalidProps("ownerEmail", errorFor("ownerEmail"))}
        />
      </Field>

      {STATUS_MESSAGES[state.status] ? (
        <p className="form-error" role="alert">
          {STATUS_MESSAGES[state.status]}
        </p>
      ) : null}

      <div className="form-actions">
        <button type="submit" className="button" disabled={pending}>
          {pending ? "Creando…" : "Dar de alta"}
        </button>
      </div>
    </form>
  );
}

function invalidProps(id: string, error: string | null) {
  return error
    ? { "aria-invalid": true as const, "aria-describedby": `${id}-error` }
    : { "aria-describedby": `${id}-hint` };
}

function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly error: string | null;
  readonly children: ReactNode;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <span id={`${id}-hint`} className="field-hint">
        {hint}
      </span>
      {children}
      {error ? (
        <span id={`${id}-error`} className="field-error">
          {error}
        </span>
      ) : null}
    </div>
  );
}
