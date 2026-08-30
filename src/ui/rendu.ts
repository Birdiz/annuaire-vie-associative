/**
 * Rendu HTML de l'UI locale.
 *
 * **Tout ce qui vient du crawl passe par `echapperHtml`.** Un nom d'association, une
 * adresse, une URL source sont des chaines lues sur un site que nous ne controlons pas :
 * c'est exactement la meme precaution que l'echappement des formules a l'export
 * (`src/export/csv.ts`), et elle vaut d'autant plus ici que l'ecran de revue est
 * l'endroit ou l'on regarde ces valeurs de pres. La CSP du serveur ferme la porte une
 * seconde fois ; aucune des deux ne dispense de l'autre.
 *
 * Pas de moteur de gabarit : des fonctions qui rendent des chaines. Le poids du bundle
 * est un critere de conception, et une dependance de plus ne se justifierait pas pour
 * trois ecrans.
 */

const ENTITES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * Echappe pour un noeud texte **et** pour une valeur d'attribut : les deux formes de
 * guillemets sont couvertes, si bien qu'un seul echappement suffit partout. Une fonction
 * par contexte laisserait le choix a l'appelant, donc l'occasion de se tromper.
 */
export function echapperHtml(valeur: unknown): string {
  return String(valeur ?? "").replace(/[&<>"']/g, (caractere) => ENTITES[caractere] ?? caractere);
}

/**
 * Une URL collectee n'est rendue en lien que si elle est http(s). Sans ce filtre, une
 * page piegee pourrait faire porter un `javascript:` a un href — l'echappement seul ne
 * l'empecherait pas, il ne protege que la syntaxe du document.
 */
export function lienSur(url: string): string | undefined {
  return /^https?:\/\//i.test(url) ? echapperHtml(url) : undefined;
}

export function nombre(valeur: number): string {
  return valeur.toLocaleString("fr-FR");
}

export function pourcent(numerateur: number, denominateur: number): string {
  if (denominateur === 0) return "—";
  return `${((numerateur / denominateur) * 100).toFixed(1).replace(".", ",")} %`;
}

/**
 * Horodatage lisible : « 30/08/2026 13:05 », dans le fuseau de la machine.
 *
 * Les colonnes de la base portent de l'ISO 8601 en UTC, et cela ne doit pas changer :
 * c'est ce qui rend les comparaisons de dates justes et l'ordre lexical fiable. Mais
 * `2026-08-30T11:05:29.852Z` demande a celui qui le lit de convertir un fuseau de tete
 * pour savoir si son run a demarre il y a deux minutes ou hier soir. L'outil tourne sur
 * sa machine : c'est l'heure de sa machine qu'il faut afficher.
 *
 * Formate a la main plutot que par `Intl` : les accesseurs `getDate`/`getHours` lisent le
 * fuseau a chaque appel — un formateur `Intl` garde en cache celui qu'il avait a sa
 * construction — et le rendu ne depend alors d'aucune donnee de locale. Le format est
 * francais parce que toute l'interface l'est.
 */
export function dateHeure(valeur: string | null | undefined): string {
  if (valeur === null || valeur === undefined || valeur === "") return "—";
  const date = new Date(valeur);
  // Une valeur illisible est rendue telle quelle : elle vient de la base, et la masquer
  // derriere un tiret ferait passer une donnee corrompue pour une donnee absente.
  if (Number.isNaN(date.getTime())) return echapperHtml(valeur);
  return `${deuxChiffres(date.getDate())}/${deuxChiffres(date.getMonth() + 1)}/${date.getFullYear()} ` +
    `${deuxChiffres(date.getHours())}:${deuxChiffres(date.getMinutes())}`;
}

/**
 * Une date seule, « 2023-08-30 » rendu « 30/08/2023 ».
 *
 * Relue caractere par caractere, sans passer par `Date` : `new Date("2023-08-30")` vaut
 * minuit UTC, et a l'ouest de Greenwich l'affichage local retomberait sur la veille. Une
 * borne de dormance decalee d'un jour se lirait comme une erreur de calcul.
 */
export function jour(valeur: string | null | undefined): string {
  if (valeur === null || valeur === undefined) return "—";
  const parties = /^(\d{4})-(\d{2})-(\d{2})/.exec(valeur);
  if (parties === null) return echapperHtml(valeur);
  return `${parties[3]}/${parties[2]}/${parties[1]}`;
}

/**
 * Une duree en clair : « 38 s », « 12 min », « 1 h 07 ».
 *
 * Trois paliers, parce qu'au-dela la precision ne sert plus a rien : ce qu'on veut savoir
 * d'un run de quarante minutes est qu'il en est a douze, pas qu'il en est a 12 min 34 s.
 */
export function duree(millisecondes: number): string {
  const secondes = Math.max(0, Math.round(millisecondes / 1000));
  if (secondes < 60) return `${secondes} s`;
  const minutes = Math.floor(secondes / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${deuxChiffres(minutes % 60)}`;
}

/** Ecart entre deux horodatages, ou `undefined` si l'un des deux est illisible. */
export function ecart(debut: string, fin: string | number): number | undefined {
  const depart = new Date(debut).getTime();
  const arrivee = typeof fin === "number" ? fin : new Date(fin).getTime();
  if (Number.isNaN(depart) || Number.isNaN(arrivee)) return undefined;
  return arrivee - depart;
}

function deuxChiffres(valeur: number): string {
  return String(valeur).padStart(2, "0");
}

/**
 * Barre de progression, en `<progress>` natif.
 *
 * **Pas de `style="width: 60%"`.** La CSP du serveur est `default-src 'self'`, donc
 * `style-src 'self'` : un attribut `style` en ligne est refuse par le navigateur, et la
 * barre resterait vide sans que rien ne le signale. Y ajouter `'unsafe-inline'` pour
 * dessiner un rectangle serait payer un affichage du garde-fou qui protege l'ecran de
 * revue. L'element natif porte sa valeur dans un attribut, se met en forme en CSS, et
 * annonce tout seul sa progression aux lecteurs d'ecran.
 */
export function barre(faits: number, total: number, libelle: string): string {
  const borne = Math.max(0, Math.min(faits, total));
  const texte = `${nombre(borne)} sur ${nombre(total)} ${libelle}`;
  return `<div class="progression">
  <progress max="${total}" value="${borne}" aria-label="${echapperHtml(texte)}"></progress>
  <span class="etiquette">${echapperHtml(texte)} — ${pourcent(borne, total)}</span>
</div>`;
}

export type Onglet = "synthese" | "revue" | "export";

export type OptionsPage = {
  titre: string;
  onglet: Onglet;
  departement: string;
  contenu: string;
  version: string;
};

export function page(options: OptionsPage): string {
  const onglet = (cible: Onglet, chemin: string, libelle: string): string =>
    `<a href="${chemin}?departement=${encodeURIComponent(options.departement)}"` +
    `${options.onglet === cible ? ' class="actif" aria-current="page"' : ""}>${libelle}</a>`;

  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${echapperHtml(options.titre)} — annuaire</title>
<link rel="stylesheet" href="/assets/annuaire.css">
<!-- htmx n'echange par defaut que les reponses 2xx. Un arbitrage refuse repond 422 —
     le code dit la verite sur ce qui s'est passe — et son corps porte le message a
     lire : il faut donc l'autoriser explicitement. La configuration passe par une
     balise meta et non par du script, que la CSP interdit. -->
<meta name="htmx-config" content='{"responseHandling":[{"code":"204","swap":false},{"code":"[23]..","swap":true},{"code":"422","swap":true},{"code":"[45]..","swap":false,"error":true}]}'>
<script src="/assets/htmx.min.js" defer></script>
</head>
<body>
<header>
  <strong>Annuaire de la vie associative</strong>
  <nav>
    ${onglet("synthese", "/", "Synthese")}
    ${onglet("revue", "/revue", "Revue")}
    ${onglet("export", "/export", "Export")}
  </nav>
  <span class="discret">departement ${echapperHtml(options.departement)} · v${echapperHtml(options.version)}</span>
</header>
<main>
${options.contenu}
</main>
<footer class="discret">
  Serveur local : rien de ce qui est affiche ici ne sort de cette machine.
</footer>
</body>
</html>
`;
}

/** Selecteur de departement, rendu en tete des ecrans qui en dependent. */
export function choixDepartement(chemin: string, departements: readonly string[], courant: string): string {
  if (departements.length <= 1) return "";
  const options = departements
    .map(
      (dept) =>
        `<option value="${echapperHtml(dept)}"${dept === courant ? " selected" : ""}>${echapperHtml(dept)}</option>`,
    )
    .join("");
  // Pas de `onchange="..."` : la CSP du serveur interdit le JS en ligne, et c'est elle
  // qui rend l'ecran de revue sur d'afficher des chaines venues d'un site tiers. Un
  // bouton coute un clic et ne demande aucune derogation.
  return `<form method="get" action="${chemin}" class="choix">
  <label>Departement <select name="departement">${options}</select></label>
  <button type="submit">Afficher</button>
</form>`;
}

/** Tableau simple : en-tetes, puis des cellules deja rendues. */
export function tableau(entetes: readonly string[], lignes: readonly (readonly string[])[]): string {
  if (lignes.length === 0) return '<p class="discret">Rien a afficher.</p>';
  return `<table>
<thead><tr>${entetes.map((titre) => `<th>${echapperHtml(titre)}</th>`).join("")}</tr></thead>
<tbody>
${lignes.map((ligne) => `<tr>${ligne.map((cellule) => `<td>${cellule}</td>`).join("")}</tr>`).join("\n")}
</tbody>
</table>`;
}
