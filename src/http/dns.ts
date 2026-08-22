/**
 * Porte DNS : la resolution MX de l'etape [7] (ADR-017).
 *
 * Elle vit dans `src/http/` parce que c'est deja le seul endroit du projet qui touche
 * au DNS — `throttle.ts` y resout l'adresse de chaque hote pour en tirer la cle /24.
 * Le resolveur MX y entre en voisin, pas en exception : toute sortie reseau reste
 * regroupee au meme endroit, et le test d'architecture peut continuer d'interdire
 * `node:dns` partout ailleurs.
 *
 * **Le delai de 2 s ne s'applique pas ici, et ce n'est pas un oubli.** L'invariant §4.3
 * protege les serveurs web des mairies d'un debit qu'elles n'ont pas demande. Une
 * requete MX ne s'adresse pas a elles : elle part vers le resolveur du systeme, qui
 * repond depuis son cache dans l'immense majorite des cas. Lui appliquer 2 s par
 * domaine ferait durer une heure ce qui prend quelques secondes, sans epargner le
 * moindre octet a qui que ce soit. Ce qui protege reellement, et qui est fait : un
 * plafond de concurrence, et un domaine interroge une seule fois.
 *
 * **Le MX est un fait de domaine, jamais d'adresse.** Il dit que le domaine sait
 * recevoir du courrier ; il ne dit rien de l'existence de la boite. Les noms de ce
 * module le disent, pour qu'aucun appelant ne puisse s'y tromper.
 */

/**
 * **Import de l'objet, jamais de la fonction nue.** `node:dns/promises` expose ses
 * methodes sur un objet qui porte le resolveur par defaut ; `resolveMx` s'en sert par
 * `this`. Importee en binding nomme — `import { resolveMx }` — elle perd cet objet et
 * retombe sur les serveurs du systeme, hors de portee de `setServers`.
 *
 * La consequence est concrete : le garde-fou de `test/helpers/pas-de-reseau.ts` pointe
 * le resolveur par defaut vers un port mort, et un import nomme le contournerait sans
 * bruit — la suite de tests sortirait sur Internet en se croyant confinee. Un test
 * d'architecture verifie donc cette ligne. `lookup()`, dont `throttle.ts` a besoin,
 * passe par le resolveur du systeme et n'est pas concerne.
 */
import dnsPromises from "node:dns/promises";

export type EnregistrementMx = { exchange: string; priority: number };

export type ResolveMxFn = (domaine: string) => Promise<readonly EnregistrementMx[]>;

export type VerdictMx = {
  domaine: string;
  /** 1 le domaine annonce un MX, 0 il n'en annonce pas, `null` la resolution a echoue. */
  mx: 0 | 1 | null;
  /** Hotes annonces, du plus prioritaire au moins. Absent si le verdict n'est pas 1. */
  hotes: readonly string[] | undefined;
  /** Renseigne uniquement quand `mx` vaut `null` : le code d'erreur du resolveur. */
  erreur: string | undefined;
};

/**
 * Codes qui signifient « ce domaine ne recevra pas de courrier », par opposition a
 * « je n'ai pas pu savoir ». La distinction est ce qui empeche un incident reseau
 * passager de condamner definitivement un domaine parfaitement valide.
 *
 * - `ENODATA` : le domaine existe mais n'annonce aucun MX.
 * - `ENOTFOUND` / `NXDOMAIN` : le domaine n'existe pas du tout.
 */
const ABSENCE_DE_MX: readonly string[] = ["ENODATA", "ENOTFOUND", "NXDOMAIN"];

/** Requetes DNS simultanees. Le resolveur du systeme n'est pas une cible a menager. */
export const CONCURRENCE_PAR_DEFAUT = 8;

const resolveParDefaut: ResolveMxFn = async (domaine) => dnsPromises.resolveMx(domaine);

export class ResolveurMx {
  readonly #resolve: ResolveMxFn;
  readonly #concurrence: number;

  /**
   * `resolve` n'est injectable que pour les tests : la suite ne sort jamais sur
   * Internet, et un verdict MX depend d'un tiers dont on ne controle pas les
   * enregistrements. La valeur de production est le resolveur du systeme.
   */
  constructor(options: { resolve?: ResolveMxFn; concurrence?: number } = {}) {
    this.#resolve = options.resolve ?? resolveParDefaut;
    this.#concurrence = Math.max(1, options.concurrence ?? CONCURRENCE_PAR_DEFAUT);
  }

  /** Verdict d'un domaine. Ne leve jamais : un echec est un verdict `null`, pas une exception. */
  async verifier(domaine: string): Promise<VerdictMx> {
    try {
      const enregistrements = await this.#resolve(domaine);
      const hotes = [...enregistrements]
        .sort((a, b) => a.priority - b.priority)
        .map((enregistrement) => enregistrement.exchange)
        .filter((hote) => hote.length > 0 && hote !== ".");
      if (hotes.length === 0) return { domaine, mx: 0, hotes: undefined, erreur: undefined };
      return { domaine, mx: 1, hotes, erreur: undefined };
    } catch (cause) {
      const code = codeDErreur(cause);
      if (ABSENCE_DE_MX.includes(code)) {
        return { domaine, mx: 0, hotes: undefined, erreur: undefined };
      }
      return { domaine, mx: null, hotes: undefined, erreur: code };
    }
  }

  /**
   * Verifie une liste de domaines, plafond de concurrence respecte. Les doublons sont
   * ecrases avant emission : le meme domaine ne part jamais deux fois.
   *
   * `onVerdict` est appele des qu'un verdict tombe, et non a la fin. C'est ce qui
   * permet a l'appelant de le persister immediatement : apres un `kill -9`, les
   * requetes deja payees ne sont pas a refaire.
   */
  async verifierTous(
    domaines: Iterable<string>,
    onVerdict: (verdict: VerdictMx) => void,
    signal?: AbortSignal,
  ): Promise<number> {
    const restants = [...new Set(domaines)];
    let index = 0;
    let verifies = 0;

    const travailleur = async (): Promise<void> => {
      for (;;) {
        if (signal?.aborted === true) return;
        const prochain = restants[index];
        index += 1;
        if (prochain === undefined) return;
        const verdict = await this.verifier(prochain);
        onVerdict(verdict);
        verifies += 1;
      }
    };

    const travailleurs = Array.from(
      { length: Math.min(this.#concurrence, restants.length) },
      () => travailleur(),
    );
    await Promise.all(travailleurs);
    return verifies;
  }
}

function codeDErreur(cause: unknown): string {
  const code = (cause as { code?: unknown } | null)?.code;
  if (typeof code === "string" && code.length > 0) return code;
  return "EUNKNOWN";
}

/**
 * Domaine d'une adresse, en minuscules. Rend `undefined` si l'adresse n'a pas la forme
 * attendue — le tri fin est le travail de la validation syntaxique, pas d'ici.
 */
export function domaineDeLAdresse(adresse: string): string | undefined {
  const arobase = adresse.lastIndexOf("@");
  if (arobase <= 0 || arobase === adresse.length - 1) return undefined;
  const domaine = adresse.slice(arobase + 1).toLowerCase();
  return domaine.includes(".") ? domaine : undefined;
}
