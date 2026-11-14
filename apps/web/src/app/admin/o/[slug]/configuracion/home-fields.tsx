"use client";

import {
  HERO_VARIANT_INFO,
  HOME_LIMITS,
  HOME_SECTION_INFO,
  MODULE_NAMES,
  type HeroVariant,
  type ModuleKey,
} from "@rikuy/core";

import type { BrandingField, HomeFigureValues, HomeValues } from "./branding-fields";

/** A destination the cover can show. */
export interface CoverOption {
  readonly id: string;
  readonly title: string;
  readonly published: boolean;
}

/**
 * «Inicio del portal» (ADR-062): the cover, two figures of the municipality and the sections
 * that follow, in order and variant. Everything is sent as plain fields (`home.*`); the
 * order is the order of the `home.order` fields.
 */
export function HomeFields({
  value,
  onChange,
  destinations,
  modules,
  errors,
  disabled,
}: {
  readonly value: HomeValues;
  readonly onChange: (home: HomeValues) => void;
  readonly destinations: readonly CoverOption[];
  /** The municipality's modules: a section of a module it does not have is not shown. */
  readonly modules: readonly ModuleKey[] | null;
  readonly errors: Partial<Record<BrandingField, string>>;
  readonly disabled: boolean;
}) {
  const setFigure = (index: 0 | 1, figure: HomeFigureValues) =>
    onChange({
      ...value,
      figures: index === 0 ? [figure, value.figures[1]] : [value.figures[0], figure],
    });
  const move = (index: number, by: -1 | 1) => {
    const sections = [...value.sections];
    const [row] = sections.splice(index, 1);
    if (row) sections.splice(index + by, 0, row);
    onChange({ ...value, sections });
  };
  const hasModule = (module: ModuleKey | undefined) =>
    module === undefined || modules === null || modules.includes(module);

  return (
    <fieldset disabled={disabled}>
      <legend>Inicio del portal</legend>
      <p className="field-hint" id="home-hint">
        Qué ve primero un visitante: la portada y las secciones que siguen, en el orden que elijas.
        Cada sección muestra solo lo que está publicado.
      </p>

      <input type="hidden" name="home.hero.variant" value={value.heroVariant} />
      {value.sections.map((section) => (
        <input key={section.key} type="hidden" name="home.order" value={section.key} />
      ))}

      <div
        className="field"
        role="radiogroup"
        aria-labelledby="home-hero-label"
        aria-invalid={errors.homeHero ? true : undefined}
        aria-describedby={errors.homeHero ? "home-hero-error" : undefined}
        tabIndex={errors.homeHero ? -1 : undefined}
      >
        <span id="home-hero-label" className="field-label">
          Portada
        </span>
        <div className="theme-choices">
          {HERO_VARIANT_INFO.map((variant) => (
            <label key={variant.key} className="theme-choice">
              <input
                type="radio"
                name="home-hero-choice"
                value={variant.key}
                checked={value.heroVariant === variant.key}
                onChange={() => onChange({ ...value, heroVariant: variant.key as HeroVariant })}
                aria-describedby={`home-hero-${variant.key}-text`}
              />
              <span className="theme-choice-name">{variant.name}</span>
              <span className="theme-choice-text" id={`home-hero-${variant.key}-text`}>
                {variant.description}
              </span>
            </label>
          ))}
        </div>
        {errors.homeHero ? (
          <span className="field-error" id="home-hero-error">
            {errors.homeHero}
          </span>
        ) : null}
      </div>

      {value.heroVariant === "photo" ? (
        <div className="field">
          <label htmlFor="home-hero-destination">Destino de la portada</label>
          <select
            id="home-hero-destination"
            name="home.hero.destination"
            value={value.heroDestination}
            aria-describedby="home-hero-destination-hint"
            onChange={(event) => onChange({ ...value, heroDestination: event.target.value })}
          >
            <option value="">El primero que tenga foto</option>
            {destinations.map((destination) => (
              <option key={destination.id} value={destination.id}>
                {destination.title}
                {destination.published ? "" : " (sin publicar)"}
              </option>
            ))}
          </select>
          <span className="field-hint" id="home-hero-destination-hint">
            Se usa su foto de portada. Si no está publicado o no tiene foto, el portal usa el primer
            destino que la tenga, o la portada de texto.
          </span>
        </div>
      ) : (
        <input type="hidden" name="home.hero.destination" value={value.heroDestination} />
      )}

      <div className="field">
        <span className="field-label" id="home-figures-label">
          Cifras propias (opcional)
        </span>
        {errors.homeFigure1 ? (
          <span className="field-error" id="home-figures-error">
            {errors.homeFigure1}
          </span>
        ) : null}
        <span className="field-hint">
          Hasta dos datos del municipio, como «1953 · Firma del Decreto de Reforma Agraria». Van
          antes de lo que el portal cuenta solo (lugares, recorridos, eventos, circuitos).
        </span>
        {([0, 1] as const).map((index) => {
          const n = String(index + 1);
          const error = errors.homeFigure1;
          const figure = value.figures[index];
          return (
            <div key={n} className="home-figure-row" role="group" aria-label={`Cifra ${n}`}>
              <label htmlFor={`home-figure-${n}-value`} className="visually-hidden">
                Cifra {n}
              </label>
              <input
                id={`home-figure-${n}-value`}
                name={`home.figure.${n}.value`}
                value={figure.value}
                maxLength={HOME_LIMITS.figureValue}
                placeholder="Ej.: 1953"
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? "home-figures-error" : undefined}
                onChange={(event) => setFigure(index, { ...figure, value: event.target.value })}
              />
              <label htmlFor={`home-figure-${n}-label`} className="visually-hidden">
                Qué es la cifra {n}
              </label>
              <input
                id={`home-figure-${n}-label`}
                name={`home.figure.${n}.label`}
                value={figure.label}
                maxLength={HOME_LIMITS.figureLabel}
                placeholder="Qué es"
                aria-invalid={error ? true : undefined}
                onChange={(event) => setFigure(index, { ...figure, label: event.target.value })}
              />
            </div>
          );
        })}
      </div>

      <div className="field">
        <span className="field-label" id="home-sections-label">
          Secciones, en orden
        </span>
        {errors.homeSections ? (
          <span className="field-error" id="home-sections-error">
            {errors.homeSections}
          </span>
        ) : null}
        <ol className="home-sections" aria-labelledby="home-sections-label">
          {value.sections.map((section, index) => {
            const info = HOME_SECTION_INFO[section.key];
            const available = hasModule(info.module);
            return (
              <li
                key={section.key}
                className="home-section-row"
                data-shown={section.shown ? "" : undefined}
              >
                <label className="checkbox">
                  <input
                    type="checkbox"
                    name={`home.show.${section.key}`}
                    checked={section.shown}
                    onChange={(event) =>
                      onChange({
                        ...value,
                        sections: value.sections.map((item, at) =>
                          at === index ? { ...item, shown: event.target.checked } : item,
                        ),
                      })
                    }
                  />
                  <span>
                    <strong>{info.name}</strong>
                    <span className="field-hint">
                      {info.description}
                      {available || !info.module
                        ? ""
                        : ` El municipio no tiene el módulo «${MODULE_NAMES[info.module]}»: no se muestra.`}
                    </span>
                  </span>
                </label>
                {info.variants.length > 1 ? (
                  <span className="home-section-variant">
                    <label htmlFor={`home-variant-${section.key}`} className="visually-hidden">
                      Variante de «{info.name}»
                    </label>
                    <select
                      id={`home-variant-${section.key}`}
                      name={`home.variant.${section.key}`}
                      value={section.variant}
                      onChange={(event) =>
                        onChange({
                          ...value,
                          sections: value.sections.map((item, at) =>
                            at === index ? { ...item, variant: event.target.value } : item,
                          ),
                        })
                      }
                    >
                      {info.variants.map((variant) => (
                        <option key={variant.key} value={variant.key}>
                          {variant.name}
                        </option>
                      ))}
                    </select>
                  </span>
                ) : (
                  <input
                    type="hidden"
                    name={`home.variant.${section.key}`}
                    value={section.variant}
                  />
                )}
                <span className="home-section-move">
                  <button
                    type="button"
                    className="button button-quiet"
                    disabled={index === 0}
                    aria-label={`Subir «${info.name}»`}
                    onClick={() => move(index, -1)}
                  >
                    Subir
                  </button>
                  <button
                    type="button"
                    className="button button-quiet"
                    disabled={index === value.sections.length - 1}
                    aria-label={`Bajar «${info.name}»`}
                    onClick={() => move(index, 1)}
                  >
                    Bajar
                  </button>
                </span>
              </li>
            );
          })}
        </ol>
      </div>
    </fieldset>
  );
}
