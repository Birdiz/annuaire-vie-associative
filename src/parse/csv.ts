/**
 * Parseur CSV incremental.
 *
 * Il travaille sur des **octets** et non sur des caracteres, pour une raison precise :
 * la reprise d'un dump interrompu se fait par un en-tete `Range`, donc en octets. Un
 * comptage en caracteres decales d'un seul multi-octet ferait redemarrer le flux au
 * milieu d'une sequence UTF-8. Les separateurs qui nous interessent (`"`, `,`, CR, LF)
 * sont tous ASCII, donc reperables sans ambiguite dans un flux UTF-8 : on peut decouper
 * les lignes au niveau octet, puis decoder chaque ligne isolement.
 *
 * `consumedBytes` ne compte que les lignes **completes et rendues** : c'est l'offset
 * auquel on peut redemarrer sans perdre ni dupliquer une ligne.
 */

const GUILLEMET = 0x22;
const CR = 0x0d;
const LF = 0x0a;

export type CsvStreamParserOptions = {
  /** Un seul caractere ASCII. Defaut : la virgule. */
  delimiter?: string;
};

export class CsvStreamParser {
  #tampon: Buffer = Buffer.alloc(0);
  #consumedBytes = 0;
  readonly #delimiter: number;

  constructor(options?: CsvStreamParserOptions) {
    const brut = options?.delimiter ?? ",";
    if (brut.length !== 1) {
      throw new Error("Le delimiteur doit etre un unique caractere");
    }
    const code = brut.charCodeAt(0);
    if (code > 0x7f) {
      throw new Error("Le delimiteur doit etre un caractere ASCII");
    }
    this.#delimiter = code;
  }

  /** Octets consommes jusqu'a la fin de la derniere ligne rendue, separateur compris. */
  get consumedBytes(): number {
    return this.#consumedBytes;
  }

  /** Rend les lignes completes contenues dans le morceau ; le reste attend la suite. */
  push(chunk: Uint8Array): string[][] {
    this.#tampon = this.#tampon.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.#tampon, chunk]);
    return this.#extraire(false);
  }

  /** Rend l'eventuelle derniere ligne, non terminee par un saut de ligne. */
  end(): string[][] {
    return this.#extraire(true);
  }

  #extraire(final: boolean): string[][] {
    const tampon = this.#tampon;
    const lignes: string[][] = [];
    let debut = 0;
    let dansGuillemets = false;

    for (let i = 0; i < tampon.length; i++) {
      const octet = tampon[i];
      if (octet === undefined) break;

      if (dansGuillemets) {
        if (octet !== GUILLEMET) continue;
        // Un guillemet double a l'interieur d'un champ quote represente un guillemet
        // litteral. En fin de tampon on ne peut pas trancher : on laisse la ligne
        // incomplete, elle sera rescannee au prochain morceau depuis son debut.
        if (tampon[i + 1] === GUILLEMET) {
          i++;
          continue;
        }
        dansGuillemets = false;
        continue;
      }

      if (octet === GUILLEMET) {
        dansGuillemets = true;
        continue;
      }

      if (octet === LF) {
        const fin = i > debut && tampon[i - 1] === CR ? i - 1 : i;
        lignes.push(this.#decouper(tampon.subarray(debut, fin)));
        debut = i + 1;
      }
    }

    this.#consumedBytes += debut;
    this.#tampon = tampon.subarray(debut);

    if (final && this.#tampon.length > 0) {
      const reste = this.#tampon;
      const fin = reste[reste.length - 1] === CR ? reste.length - 1 : reste.length;
      lignes.push(this.#decouper(reste.subarray(0, fin)));
      this.#consumedBytes += reste.length;
      this.#tampon = Buffer.alloc(0);
    }

    return lignes;
  }

  #decouper(ligne: Buffer): string[] {
    const champs: string[] = [];
    let debut = 0;
    let dansGuillemets = false;

    for (let i = 0; i < ligne.length; i++) {
      const octet = ligne[i];
      if (octet === undefined) break;

      if (dansGuillemets) {
        if (octet !== GUILLEMET) continue;
        if (ligne[i + 1] === GUILLEMET) {
          i++;
          continue;
        }
        dansGuillemets = false;
        continue;
      }

      if (octet === GUILLEMET) {
        dansGuillemets = true;
        continue;
      }

      if (octet === this.#delimiter) {
        champs.push(decoderChamp(ligne.subarray(debut, i)));
        debut = i + 1;
      }
    }

    champs.push(decoderChamp(ligne.subarray(debut)));
    return champs;
  }
}

function decoderChamp(octets: Buffer): string {
  const texte = octets.toString("utf8");
  if (texte.length >= 2 && texte.startsWith('"') && texte.endsWith('"')) {
    return texte.slice(1, -1).replaceAll('""', '"');
  }
  return texte;
}

/**
 * Associe chaque ligne aux noms de colonnes de l'en-tete.
 *
 * Les colonnes absentes rendent une chaine vide plutot que `undefined` : un dump public
 * peut gagner ou perdre une colonne d'un mois sur l'autre, et une lecture manquante ne
 * doit pas faire tomber tout un seed.
 */
export function indexerColonnes(entete: readonly string[]): (ligne: readonly string[]) => (nom: string) => string {
  const positions = new Map<string, number>();
  entete.forEach((nom, index) => positions.set(nom.trim(), index));
  return (ligne) => (nom) => {
    const index = positions.get(nom);
    if (index === undefined) return "";
    return ligne[index] ?? "";
  };
}
