import { formatTokens, meter, type OperationsSnapshot } from "@rikuy/core";
import Link from "next/link";

import { UsageBar } from "@/components/usage/usage-bar";
import type { AiGatewayStatus } from "@/server/ai-gateway";

import { AiProbeForm } from "./ai-probe-form";

/**
 * «Asistente con IA» in /plataforma (ADR-036): whether this deployment has AI, how much of
 * the platform's daily cap is used, what happened in the last 24 hours, and «Probar la IA».
 */
export function AiSummary({
  ai,
  voice,
  status,
  tenants,
}: {
  readonly ai: OperationsSnapshot["ai"];
  readonly voice: OperationsSnapshot["voice"];
  readonly status: AiGatewayStatus;
  readonly tenants: readonly { readonly tenantId: string; readonly displayName: string }[];
}) {
  const connection =
    status.invalidKeys.length > 0
      ? `Configuración con errores en ${status.invalidKeys.join(", ")}: el portal funciona igual y el asistente muestra su aviso hasta que se corrija.`
      : !status.configured
        ? "Sin configurar en este despliegue: el portal funciona igual y el asistente muestra su aviso."
        : status.provider === "simulated"
          ? `Modelo simulado (${status.model}), solo para desarrollo: no llama a ningún proveedor.`
          : `Conectado a Groq con ${status.model} (dictado por voz con ${status.transcriptionModel}).`;
  return (
    <section aria-labelledby="ia" className="operations">
      <h2 id="ia">Asistente con IA</h2>
      <p>{connection}</p>
      {status.invalidKeys.includes("AI_DATABASE_URL") ? (
        <p className="field-hint">
          Si la contraseña de <code>rikuy_ai</code> tiene símbolos como # / ? o %, cámbiala por una
          solo con letras y números (o escríbelos codificados: %23, %2F, %3F, %25) y vuelve a
          desplegar.
        </p>
      ) : null}
      <ul className="usage-list">
        {ai ? (
          <li className="usage-card">
            <h3>IA de la plataforma hoy</h3>
            <p className="field-hint">
              Lo que usan todos los municipios juntos, contra el tope de la plataforma (el 90 % de
              lo que da el plan gratuito de Groq por día). Se renueva a medianoche UTC (20:00 en
              Bolivia).
            </p>
            <UsageBar
              meter={meter({
                resource: "ai_tokens",
                limit: ai.limit,
                consumed: ai.used,
                reserved: 0,
                periodStart: null,
                periodEnd: null,
              })}
              label="IA de la plataforma hoy"
            />
          </li>
        ) : null}
        {ai ? (
          <li className="usage-card">
            <h3>Últimas 24 h</h3>
            <p>
              {ai.answered24h === 1 ? "1 respuesta" : `${formatTokens(ai.answered24h)} respuestas`},{" "}
              {ai.refused24h === 1 ? "1 rechazada" : `${formatTokens(ai.refused24h)} rechazadas`}{" "}
              por un límite y{" "}
              {ai.failed24h === 1
                ? "1 sin respuesta"
                : `${formatTokens(ai.failed24h)} sin respuesta`}{" "}
              del proveedor.
            </p>
            <Link href="/plataforma/cuotas">Cuotas de IA por municipio</Link>
          </li>
        ) : null}
        {voice ? (
          <li className="usage-card">
            <h3>Dictado por voz hoy</h3>
            <p className="field-hint">
              Los segundos de voz que dictan los visitantes de todos los municipios, contra el tope
              de la plataforma (el 90 % de lo que da el plan gratuito de Groq por día). Cada dictado
              cuenta al menos 10 s. En las últimas 24 h:{" "}
              {voice.transcribed24h === 1
                ? "1 pasado a texto"
                : `${formatTokens(voice.transcribed24h)} pasados a texto`}
              ,{" "}
              {voice.refused24h === 1
                ? "1 rechazado"
                : `${formatTokens(voice.refused24h)} rechazados`}{" "}
              por un límite y{" "}
              {voice.failed24h === 1 ? "1 sin texto" : `${formatTokens(voice.failed24h)} sin texto`}{" "}
              del proveedor.
            </p>
            <UsageBar
              meter={meter({
                resource: "ai_audio_seconds",
                limit: voice.limit,
                consumed: voice.used,
                reserved: 0,
                periodStart: null,
                periodEnd: null,
              })}
              label="Dictado por voz de la plataforma hoy"
            />
          </li>
        ) : null}
        <li className="usage-card">
          <h3>Probar la IA</h3>
          <p className="field-hint">
            Manda la pregunta más corta posible a nombre de un municipio y cuenta en su cuota. Sirve
            para comprobar la clave de Groq y para ver qué pasa con una cuota agotada.
          </p>
          <AiProbeForm tenants={tenants} />
        </li>
        <li className="usage-card">
          <h3>Evaluar el asistente</h3>
          <p className="field-hint">
            Las 40 preguntas del gold, con el modelo real, sobre una demo con el contenido de
            muestra.
          </p>
          <Link href="/plataforma/asistente">Evaluar el asistente</Link>
        </li>
      </ul>
    </section>
  );
}
