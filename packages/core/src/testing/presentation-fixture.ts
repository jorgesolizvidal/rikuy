import type { TenantPresentationInput } from "../contracts/presentation";

/** Valid presentation used by tests (fictional tenant). */
export function samplePresentation(): TenantPresentationInput {
  return {
    identity: {
      siteName: "Municipio Demo Norte",
      shortName: "Demo Norte",
      tagline: "Valles y ferias",
    },
    theme: { mode: "light", brand: "#1F6F4A", accent: "#a06f12" },
    contact: { email: "turismo@demo-norte.example.test", phone: "+591 4 000 0000" },
    social: [{ network: "facebook", url: "https://facebook.com/demo-norte" }],
    seo: { description: "Destinos, eventos y tours 360° de un municipio de demostración." },
  };
}
