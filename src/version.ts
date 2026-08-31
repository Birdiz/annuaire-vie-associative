/**
 * Version du produit, annoncee dans le User-Agent.
 *
 * Constante plutot que lecture de package.json : l'artefact Windows est un executable
 * unique sans fichiers voisins (ADR-001). Un test verifie que cette valeur reste
 * synchronisee avec package.json.
 */
export const VERSION = "1.0.0";
