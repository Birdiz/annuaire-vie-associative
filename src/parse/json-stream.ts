/**
 * Decoupeur d'un grand tableau JSON en objets individuels.
 *
 * Le dump de l'Annuaire fait 273 Mo : `JSON.parse` sur le tout demanderait plusieurs Go
 * de memoire. On isole donc chaque objet du tableau par **suivi de la profondeur
 * d'accolades**, en respectant les chaines et leurs echappements, puis on ne parse que
 * l'objet courant (~5 Ko).
 *
 * Le fichier reel separe ses objets par exactement `\n  }, {\n`, ce qui inviterait a un
 * simple `split`. On s'en garde : cette mise en forme appartient au producteur, qui
 * regenere le fichier chaque jour, et rien ne la documente. Un scanner de profondeur ne
 * depend d'aucune convention de formatage.
 *
 * Le scan se fait sur des octets : tous les caracteres structurels de JSON sont ASCII et
 * les octets de continuation UTF-8 valent 0x80 ou plus, donc aucune confusion possible.
 *
 * Les elements du tableau qui ne sont pas des objets sont ignores.
 */

const ACCOLADE_OUVRANTE = 0x7b;
const ACCOLADE_FERMANTE = 0x7d;
const CROCHET_OUVRANT = 0x5b;
const CROCHET_FERMANT = 0x5d;
const GUILLEMET = 0x22;
const ANTISLASH = 0x5c;

/** Au-dela, on considere que la cle attendue est absente plutot que d'accumuler sans fin. */
const FENETRE_RECHERCHE_MAX = 64 * 1024;

export class JsonArrayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsonArrayError";
  }
}

export class JsonArraySplitter {
  readonly #motif: Buffer;
  readonly #cle: string;
  #tampon: Buffer = Buffer.alloc(0);
  #scan = 0;
  #phase: "recherche" | "tableau" | "fini" = "recherche";
  #profondeur = 0;
  #dansChaine = false;
  #echappe = false;
  #debutObjet: number | null = null;

  constructor(cle: string) {
    this.#cle = cle;
    this.#motif = Buffer.from(`"${cle}"`, "utf8");
  }

  push(chunk: Uint8Array): string[] {
    if (this.#phase === "fini") return [];
    this.#tampon = this.#tampon.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.#tampon, chunk]);
    const objets: string[] = [];
    if (this.#phase === "recherche") {
      this.#chercherTableau();
    }
    if (this.#phase === "tableau") {
      this.#extraireObjets(objets);
    }
    return objets;
  }

  end(): string[] {
    if (this.#phase === "recherche") {
      throw new JsonArrayError(`Le tableau "${this.#cle}" est introuvable dans le flux`);
    }
    if (this.#phase === "tableau" && this.#debutObjet !== null) {
      throw new JsonArrayError("Le flux s'interrompt au milieu d'un objet");
    }
    return [];
  }

  /** Vrai si le crochet fermant du tableau a ete atteint. */
  get termine(): boolean {
    return this.#phase === "fini";
  }

  #chercherTableau(): void {
    const tampon = this.#tampon;
    let depuis = 0;
    for (;;) {
      const trouve = tampon.indexOf(this.#motif, depuis);
      if (trouve < 0) break;
      let i = trouve + this.#motif.length;
      while (i < tampon.length && estBlanc(tampon[i])) i++;
      if (i >= tampon.length) return; // ponctuation pas encore recue
      if (tampon[i] !== 0x3a) {
        depuis = trouve + 1;
        continue;
      }
      i++;
      while (i < tampon.length && estBlanc(tampon[i])) i++;
      if (i >= tampon.length) return;
      if (tampon[i] !== CROCHET_OUVRANT) {
        depuis = trouve + 1;
        continue;
      }
      // On entre dans le tableau : tout ce qui precede ne sera plus relu.
      this.#tampon = tampon.subarray(i + 1);
      this.#scan = 0;
      this.#phase = "tableau";
      return;
    }

    if (this.#tampon.length > FENETRE_RECHERCHE_MAX) {
      throw new JsonArrayError(
        `Le tableau "${this.#cle}" n'apparait pas dans les ${FENETRE_RECHERCHE_MAX} premiers octets`,
      );
    }
  }

  #extraireObjets(objets: string[]): void {
    const tampon = this.#tampon;
    let consomme = 0;

    for (let i = this.#scan; i < tampon.length; i++) {
      const octet = tampon[i];
      if (octet === undefined) break;

      if (this.#dansChaine) {
        if (this.#echappe) {
          this.#echappe = false;
        } else if (octet === ANTISLASH) {
          this.#echappe = true;
        } else if (octet === GUILLEMET) {
          this.#dansChaine = false;
        }
        continue;
      }

      if (octet === GUILLEMET) {
        this.#dansChaine = true;
        continue;
      }

      if (octet === ACCOLADE_OUVRANTE) {
        if (this.#profondeur === 0) this.#debutObjet = i;
        this.#profondeur++;
        continue;
      }

      if (octet === ACCOLADE_FERMANTE) {
        this.#profondeur--;
        if (this.#profondeur === 0 && this.#debutObjet !== null) {
          objets.push(tampon.subarray(this.#debutObjet, i + 1).toString("utf8"));
          this.#debutObjet = null;
          consomme = i + 1;
        }
        continue;
      }

      if (octet === CROCHET_FERMANT && this.#profondeur === 0) {
        this.#phase = "fini";
        consomme = i + 1;
        this.#tampon = Buffer.alloc(0);
        this.#scan = 0;
        return;
      }
    }

    // On ne garde que l'objet en cours de lecture, jamais ce qui a deja ete rendu.
    const garde = this.#debutObjet ?? consomme;
    if (garde > 0) {
      this.#tampon = tampon.subarray(garde);
      if (this.#debutObjet !== null) this.#debutObjet -= garde;
    }
    this.#scan = this.#tampon.length;
  }
}

function estBlanc(octet: number | undefined): boolean {
  return octet === 0x20 || octet === 0x09 || octet === 0x0a || octet === 0x0d;
}
