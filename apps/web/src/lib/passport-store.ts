"use client";

import {
  addStamp,
  parseStoredPassport,
  PASSPORT_STORAGE_KEY,
  passportIdFrom,
  rememberVoucher,
  serializePassport,
  type AddStampOutcome,
  type PassportStamp,
  type StoredPassport,
  type StoredVoucher,
} from "@rikuy/core/passport-client";
import { useSyncExternalStore } from "react";

/**
 * The passport kept by this phone (ADR-057): its stamps, in this portal's localStorage (each
 * portal is its own origin). No account and nothing on the server; clearing the browser's
 * data clears the stamps. Nothing is written until the visitor presses «Sellar».
 */

let cached: { readonly raw: string | null; readonly passport: StoredPassport | null } | null = null;
const listeners = new Set<() => void>();

function readRaw(): string | null {
  try {
    return window.localStorage.getItem(PASSPORT_STORAGE_KEY);
  } catch {
    return null;
  }
}

function current(): StoredPassport | null {
  const raw = readRaw();
  if (cached?.raw !== raw) cached = { raw, passport: parseStoredPassport(raw) };
  return cached.passport;
}

function write(passport: StoredPassport): boolean {
  try {
    window.localStorage.setItem(PASSPORT_STORAGE_KEY, serializePassport(passport));
  } catch {
    return false;
  }
  for (const listener of listeners) listener();
  return true;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Another tab of the same portal stamped.
  const onStorage = (event: StorageEvent) => {
    if (event.key === PASSPORT_STORAGE_KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** The passport, null when this phone has none, undefined while rendering on the server. */
export function usePassport(): StoredPassport | null | undefined {
  return useSyncExternalStore(subscribe, current, () => undefined);
}

/**
 * The passport id stamps are signed for: the one this phone has, or a new one kept right
 * away (so the stamp that comes back belongs to it). Null when the browser keeps nothing
 * (some private windows).
 */
export function ensurePassportId(): string | null {
  const existing = current();
  if (existing) return existing.id;
  const id = passportIdFrom(crypto.getRandomValues(new Uint8Array(16)));
  return write({ id, stamps: {} }) ? id : null;
}

/** Keeps a stamp just received; null when it could not be kept. */
export function keepStamp(passportId: string, stamp: PassportStamp): AddStampOutcome | null {
  const passport = current();
  if (passport === null || passport.id !== passportId) return null;
  const { passport: next, outcome } = addStamp(passport, stamp);
  if (outcome === "kept") return outcome;
  return write(next) ? outcome : null;
}

/** Keeps the voucher of a circuit's prize (ADR-058); false when it could not be kept. */
export function keepVoucher(circuit: string, voucher: StoredVoucher): boolean {
  const passport = current();
  if (passport === null) return false;
  const kept = passport.vouchers?.[circuit];
  if (
    kept?.code === voucher.code &&
    kept.expiresAt === voucher.expiresAt &&
    kept.redeemedAt === voucher.redeemedAt
  ) {
    return true;
  }
  return write(rememberVoucher(passport, circuit, voucher));
}
