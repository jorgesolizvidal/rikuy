"use client";

import type { MembershipRole } from "@rikuy/core";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useId, useState } from "react";

import {
  changeRoleAction,
  inviteMemberAction,
  revokeMemberAction,
  type MemberActionState,
} from "./actions";

interface RoleOption {
  readonly value: MembershipRole;
  readonly label: string;
}

const IDLE: MemberActionState = { status: "idle" };

const MESSAGES: Partial<Record<MemberActionState["status"], string>> = {
  forbidden: "Tu rol no permite este cambio.",
  not_found: "Ese miembro ya no existe. Recarga la página.",
  last_owner: "El municipio debe conservar al menos un propietario activo.",
  already_member: "Esa persona ya es miembro o tiene una invitación pendiente.",
  invalid_email: "Escribe un correo válido.",
  invalid_role: "Elige un rol válido.",
  error: "No se pudo guardar. Inténtalo de nuevo.",
};

/** Refreshes the server-rendered roster after a successful change. */
function useRefreshOnDone(state: MemberActionState) {
  const router = useRouter();
  useEffect(() => {
    if (state.status === "done") router.refresh();
  }, [state, router]);
}

export function InviteMemberForm({
  slug,
  roles,
}: {
  readonly slug: string;
  readonly roles: readonly RoleOption[];
}) {
  const [state, action, pending] = useActionState(inviteMemberAction, IDLE);
  const id = useId();
  useRefreshOnDone(state);
  const message = MESSAGES[state.status];

  return (
    <form action={action} className="invite-form">
      <input type="hidden" name="slug" value={slug} />
      <div className="field">
        <label htmlFor={`${id}-email`}>Correo</label>
        <input
          id={`${id}-email`}
          name="email"
          type="email"
          required
          autoComplete="off"
          aria-invalid={state.status === "invalid_email" ? true : undefined}
        />
      </div>
      <div className="field">
        <label htmlFor={`${id}-role`}>Rol</label>
        <select id={`${id}-role`} name="role" defaultValue={roles.at(-1)?.value}>
          {roles.map((role) => (
            <option key={role.value} value={role.value}>
              {role.label}
            </option>
          ))}
        </select>
      </div>
      <button type="submit" className="button" disabled={pending}>
        {pending ? "Invitando…" : "Invitar"}
      </button>
      <p className={message ? "form-error" : "form-success"} role="status">
        {message ??
          (state.status === "done"
            ? "Invitación creada. La persona la verá al entrar al panel con su correo."
            : "")}
      </p>
    </form>
  );
}

export function MemberRowActions({
  slug,
  membershipId,
  email,
  currentRole,
  roles,
}: {
  readonly slug: string;
  readonly membershipId: string;
  readonly email: string;
  readonly currentRole: MembershipRole;
  readonly roles: readonly RoleOption[];
}) {
  const [roleState, changeRole, changing] = useActionState(changeRoleAction, IDLE);
  const [revokeState, revoke, revoking] = useActionState(revokeMemberAction, IDLE);
  const [role, setRole] = useState(currentRole);
  const [confirming, setConfirming] = useState(false);
  const selectId = useId();
  useRefreshOnDone(roleState);
  useRefreshOnDone(revokeState);
  const message = MESSAGES[roleState.status] ?? MESSAGES[revokeState.status];

  return (
    <div className="row-actions">
      <form action={changeRole} className="inline-form">
        <input type="hidden" name="slug" value={slug} />
        <input type="hidden" name="membershipId" value={membershipId} />
        <input type="hidden" name="currentRole" value={currentRole} />
        <label htmlFor={selectId} className="visually-hidden">
          Nuevo rol de {email}
        </label>
        <select
          id={selectId}
          name="role"
          value={role}
          onChange={(e) => setRole(e.target.value as MembershipRole)}
        >
          {roles.some((option) => option.value === currentRole) ? null : (
            <option value={currentRole} disabled>
              {currentRole}
            </option>
          )}
          {roles.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <button
          type="submit"
          className="button button-quiet"
          disabled={changing || role === currentRole}
        >
          Cambiar rol
        </button>
      </form>

      <form action={revoke} className="inline-form">
        <input type="hidden" name="slug" value={slug} />
        <input type="hidden" name="membershipId" value={membershipId} />
        <input type="hidden" name="currentRole" value={currentRole} />
        {confirming ? (
          <>
            <button type="submit" className="button button-danger" disabled={revoking}>
              Confirmar: quitar acceso a {email}
            </button>
            <button
              type="button"
              className="button button-quiet"
              onClick={() => setConfirming(false)}
            >
              Cancelar
            </button>
          </>
        ) : (
          <button type="button" className="button button-quiet" onClick={() => setConfirming(true)}>
            Quitar acceso
          </button>
        )}
      </form>

      {message ? (
        <span className="field-error" role="status">
          {message}
        </span>
      ) : null}
    </div>
  );
}
