/**
 * Materialisation des invariants du §4 du brief.
 *
 * Ces valeurs ne sont deliberement PAS exposees dans la configuration. C'est leur
 * absence de la surface de config qui les rend non contournables : un utilisateur
 * ne peut pas les desactiver, et le code n'a nulle part ou aller les chercher.
 *
 * Ne pas rendre ces constantes reglables, ni les lire depuis l'environnement.
 */

/** §4.3 — 1 requete / 2 s minimum par domaine. */
export const MIN_DELAY_PER_DOMAIN_MS = 2_000;

/** §4.8 — les donnees de plus de 3 ans sont purgees au demarrage. */
export const RETENTION_YEARS = 3;

/** §4.4 — produit annonce dans le User-Agent, suivi de l'URL de contact. */
export const USER_AGENT_PRODUCT = "AnnuaireVieAssociative";

/** Garde-fous de collecte. Plafonds, pas des reglages de confort. */
export const MAX_REDIRECTS = 5;
export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
export const REQUEST_TIMEOUT_MS = 20_000;

/** Prefixes de mobiles francais, exclus par defaut (§4.6). */
export const MOBILE_PREFIXES = ["06", "07"] as const;
