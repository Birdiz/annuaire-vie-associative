/**
 * Mode d'emploi, a l'ecran.
 *
 * **Pas dans le README.** Celui-ci s'adresse a qui clone le depot : il parle de `npm`, de
 * CSP, de bundle et renvoie a des ADR. La personne qui utilise l'outil, elle, a
 * double-clique sur un executable et regarde un navigateur — elle n'ira jamais lire un
 * fichier Markdown sur une forge. Le mode d'emploi doit etre a l'endroit ou elle est.
 *
 * Le cout est un ecran de texte statique, sans requete ni dependance : le poids du bundle
 * ne bouge pas de facon mesurable, et c'est ce qui rendait l'ajout discutable.
 *
 * **Aucune reference interne** — ni ADR, ni numero de paragraphe du brief, ni nom de
 * table. Les seules references sont legales, parce qu'elles designent un texte que le
 * lecteur peut aller lire.
 *
 * Le texte rendu porte ses accents : la regle du projet les interdit dans les
 * identifiants, pas dans ce qui s'affiche.
 */

import { echapperHtml } from "../rendu.ts";

export type DonneesAide = {
  /** Ou l'outil ecrit sur cette machine. Affiche parce que c'est une question courante. */
  dataDir: string;
  /** Le departement affiche, pour que les liens ramenent la ou on etait. */
  departement: string;
};

export function ecranAide(donnees: DonneesAide): string {
  const dept = encodeURIComponent(donnees.departement);

  return `<h2>Mode d'emploi</h2>

<p class="intro">Cet outil constitue <strong>l'annuaire des associations d'un département</strong>.
Il part de deux fichiers publics — le registre national des associations et l'annuaire de
l'administration — puis va lire les sites des mairies du département pour y trouver les adresses
et les téléphones des associations. Chaque ligne produite porte l'adresse de la page où elle a été
lue, la date de lecture et une note de confiance : vous pouvez toujours remonter à la source.</p>

<p class="discret">Ce qu'il ne fait pas : envoyer des messages, consulter les réseaux sociaux, ni
transmettre quoi que ce soit à l'éditeur de l'outil.</p>

<h2>Les cinq étapes</h2>

<ol class="marche">
  <li>
    <h3>Renseigner l'URL de contact — une fois pour toutes</h3>
    <p>Chaque page visitée reçoit l'adresse d'une page où vous joindre, pour qu'un webmestre de
    mairie puisse vous écrire s'il a une question. <strong>Sans elle, rien n'est collecté</strong> :
    ce n'est pas un réglage, c'est une condition. Une page « contact » de votre collectivité convient.</p>
    <p class="discret">Station <a href="/preparer?departement=${dept}">Préparer</a>.</p>
  </li>

  <li>
    <h3>Choisir le département</h3>
    <p>La plaque du département, en haut à gauche de chaque écran. Ouvrez-la, tapez le code —
    <code>35</code>, <code>2A</code> en Corse, <code>971</code> outre-mer — puis « Ouvrir ». Un
    département encore jamais collecté s'ouvre vide, et la plaque le dit : c'est normal, l'étape
    suivante le remplira.</p>
    <p class="discret">Trois départements restent hors de portée : le 57, le 67 et le 68. Le droit
    local d'Alsace-Moselle place leurs associations dans un autre registre, que cet outil ne lit pas.</p>
  </li>

  <li>
    <h3>Lancer la collecte, et la laisser travailler</h3>
    <p>Station <a href="/collecter?departement=${dept}">Collecter</a>, bouton « Lancer la collecte
    complète ». <strong>Comptez plusieurs heures</strong>, parfois une journée sur un gros
    département.</p>
    <p>Cette lenteur est voulue et ne se règle pas : l'outil attend <strong>deux secondes entre
    deux visites d'un même site</strong>, pour ne pas peser sur des serveurs de mairie qui n'ont
    rien demandé. Aller plus vite reviendrait à se faire bloquer, et à le mériter.</p>
    <p>Vous pouvez fermer la fenêtre, éteindre le poste, revenir demain : <strong>tout reprend où
    cela s'était arrêté</strong>. Rien n'est perdu et rien n'est refait deux fois.</p>
  </li>

  <li>
    <h3>Relire ce dont l'outil n'est pas sûr</h3>
    <p>Station <a href="/relire?departement=${dept}">Relire</a>. On y trouve ce que l'outil n'a pas
    su trancher seul, <strong>les cas les moins sûrs en premier</strong> — c'est là que votre lecture
    apporte quelque chose. Chaque carte affiche ce qui a fait baisser la note, l'extrait de la page
    où la valeur a été lue, et un lien vers cette page. <strong>Pas besoin d'attendre la fin de la
    collecte</strong> : la file se remplit à mesure.</p>
    <p class="discret">Cette étape n'est pas obligatoire. L'export fonctionne sans ; la revue
    améliore le fichier, elle ne le conditionne pas.</p>
  </li>

  <li>
    <h3>Exporter le fichier</h3>
    <p>Station <a href="/exporter?departement=${dept}">Exporter</a>. Vous obtenez un fichier CSV, qui
    s'ouvre dans un tableur. Le « score minimum » filtre sur la confiance : <code>0.6</code> est un
    point de départ raisonnable, un champ vide sort tout, y compris ce dont l'outil doute.</p>
    <p class="discret">Deux fichiers possibles. Le <strong>fichier simple</strong> tient en six
    colonnes — département, commune, nom, type, téléphone, e-mail — avec une ligne par structure : c'est
    celui qu'on travaille. Le <strong>fichier complet</strong> ajoute, pour chaque contact, la page
    d'où il vient, la date de lecture, la méthode et le score : c'est celui qu'on garde pour
    pouvoir répondre « d'où sort cette adresse ? ». Le fichier simple écarte les contacts que
    l'outil n'a pas su nommer, et ceux que la page ne nommait que par une personne : une ligne y
    nomme toujours une structure. L'écran vous dit combien.</p>
  </li>
</ol>

<h2>Avant de vous servir du fichier</h2>

<p>C'est la partie à ne pas sauter, et elle tient en une phrase :
<strong>ce fichier contient des données personnelles, et vous en êtes responsable</strong> — pas
l'éditeur de l'outil. C'est la conséquence directe du fait que tout se passe sur votre machine :
c'est vous qui collectez.</p>

<p>Trois obligations concrètes :</p>

<ul class="obligations">
  <li><strong>Informer les personnes concernées.</strong> Vous n'avez pas recueilli ces données
  auprès d'elles mais sur des sites publics. L'article 14 du RGPD vous oblige alors à les informer,
  dans un délai d'un mois, ou dès votre première communication avec elles si elle vient avant.</li>

  <li><strong>Lire la colonne <code>regime</code> du fichier.</strong> <code>generique</code>
  désigne une adresse de fonction — <code>contact@</code>, <code>mairie@</code> ;
  <code>nominatif</code> une adresse qui identifie une personne —
  <code>prenom.nom@</code> ; <code>indetermine</code> un cas que l'outil a refusé de trancher
  plutôt que de deviner. Ces trois cas n'appellent pas les mêmes précautions.</li>

  <li><strong>Ce n'est pas un fichier de prospection.</strong> L'outil n'envoie aucun message et ne
  prépare pas de campagne. S'en servir pour démarcher est un autre traitement, avec ses propres
  règles, et il ne vous est pas fourni avec.</li>
</ul>

<p>Si une personne demande à être effacée : le bouton <strong>« Oublier »</strong>, replié sous
la carte de relecture. Il supprime la donnée, efface la copie de la page gardée en cache, et inscrit une exclusion
pour qu'elle ne revienne pas à la collecte suivante — sans quoi effacer ne durerait que jusqu'à la
collecte d'après.</p>

<h2>Questions courantes</h2>

<dl class="faq">
  <dt>Rien ne bouge depuis vingt minutes. C'est bloqué ?</dt>
  <dd>Probablement pas. Deux secondes entre chaque visite d'un même site, sur des milliers de
  pages, cela fait des heures où l'écran avance à peine. La station Collecter dit ce qui se passe
  réellement : la barre de progression, les compteurs, et les dernières pages visitées.</dd>

  <dt>Mon département n'affiche que des zéros.</dt>
  <dd>Il n'a jamais été collecté. La plaque du haut l'indique. Lancez la collecte.</dd>

  <dt>Où sont mes données ?</dt>
  <dd>Dans <code>${echapperHtml(donnees.dataDir)}</code>, sur cette machine. On y trouve la base,
  le cache des pages lues et le journal. Supprimer ce dossier efface tout le travail.</dd>

  <dt>Est-ce que quelque chose sort de mon poste ?</dt>
  <dd>Vers les sites des mairies, oui — c'est le travail de l'outil, et chaque visite annonce votre
  URL de contact. Vers l'éditeur de l'outil, jamais : aucune mesure d'usage, aucun envoi.</dd>

  <dt>Et les numéros de portable ?</dt>
  <dd>Les numéros fixes sont toujours collectés ; la question ne porte que sur les mobiles. Ceux-là
  sont écartés par défaut : un 06 publié sur le site d'une commune est presque toujours la ligne
  personnelle d'un bénévole, pas le téléphone d'un local associatif. Une case permet de les
  conserver, avec ce que cela engage ; elle se remet à zéro à chaque lancement de l'outil. L'export,
  lui, ne filtre aucun numéro : il sort ce qui a été collecté.</dd>

  <dt>Certaines communes ne remontent rien, alors qu'elles ont bien un annuaire.</dt>
  <dd>C'est attendu, et les causes sont connues. La plus fréquente de loin : <strong>aucun site
  n'est déclaré</strong> pour la commune dans l'Annuaire de l'administration, la seule source
  d'adresses de l'outil — sur un département testé, deux tiers des communes étaient dans ce cas, et
  l'outil ne va alors nulle part. Viennent ensuite le <code>robots.txt</code> du site, qui interdit
  la visite et se respecte sans dérogation ; l'annuaire <strong>affiché par du JavaScript</strong>,
  que l'outil ne peut pas exécuter, ou <strong>publié en PDF</strong>, qu'il ne télécharge pas ;
  l'annuaire <strong>paginé</strong> dont les pages suivantes changent d'adresse au point de
  ne plus rien annoncer, et que l'outil ne reconnaît alors pas comme la suite ; le
  <strong>budget de vingt pages</strong> par commune, atteint avant d'arriver à la bonne rubrique ;
  les <strong>mobiles 06/07</strong> écartés par défaut, qui vident une fiche n'ayant qu'un
  portable ; et enfin des contacts bel et bien collectés mais <strong>écartés du fichier
  simple</strong>, faute de nom ou d'indice de vie associative — l'écran d'export les compte, et le
  fichier complet les contient. Pour trancher commune par commune :
  <code>annuaire communes --departement ${echapperHtml(donnees.departement)}</code> dit, pour
  chacune, si un site a été trouvé et ce que la visite a donné.</dd>

  <dt>Je veux un deuxième département.</dt>
  <dd>La plaque du haut : tapez son code, puis lancez la collecte. Sachez que chaque département
  relit le registre national en entier — 1,25 Go à chaque fois — car il n'est pas conservé sur
  votre disque.</dd>

  <dt>Puis-je collecter la France entière d'un coup ?</dt>
  <dd>Non, et ce n'est pas un oubli. À deux secondes par site et environ 35 000 communes, une telle
  collecte durerait plusieurs jours sans interruption. L'outil travaille département par
  département.</dd>
</dl>
`;
}

/**
 * Le panneau « ? » (ADR-041) : l'aide de l'ecran ou l'on est, ouverte par-dessus sans le
 * quitter — on lit la legende des quatre boutons la carte toujours sous les yeux. Un
 * `popover` declaratif : aucune ligne de script. Le mode d'emploi complet reste une page,
 * pour qui veut le lire d'une traite ou n'a pas de navigateur recent.
 */
export function panneauAide(ecran: "preparer" | "collecter" | "relire" | "exporter", departement: string): string {
  const dept = encodeURIComponent(departement);
  return `<div class="panneau-entete">
  <h2>Aide</h2>
  <button type="button" popovertarget="aide" popovertargetaction="hide">Fermer</button>
</div>
<h3>Sur cet écran</h3>
${SUR_CET_ECRAN[ecran]}
<h3>Les cinq étapes</h3>
<ol class="etapes-courtes">
  <li>Renseigner l'URL de contact, une fois</li>
  <li>Choisir le département</li>
  <li>Lancer la collecte et la laisser travailler</li>
  <li>Relire ce dont l'outil n'est pas sûr</li>
  <li>Exporter le fichier</li>
</ol>
<h3>Questions fréquentes</h3>
<dl class="faq">
  <dt>Que veulent dire « score » et « lu » ?</dt>
  <dd>« Lu » : à quel point l'outil est sûr d'avoir bien lu la valeur sur la page. « Score » : à
  quel point il pense qu'elle vaut d'être publiée — le domaine reçoit-il du courrier, l'adresse
  désigne-t-elle une personne, est-elle rattachée à une association.</dd>
  <dt>Pourquoi relire pendant la collecte ?</dt>
  <dd>Parce que la collecte dure des heures, et que la file se remplit à mesure. Ce qui est
  arbitré reste arbitré ; seul le score peut encore bouger, quand la normalisation vérifie le
  domaine des adresses.</dd>
  <dt>Pourquoi les mobiles sont-ils exclus ?</dt>
  <dd>Un 06 publié sur le site d'une commune est presque toujours la ligne personnelle d'un
  bénévole. Les conserver reste possible, dans Préparer, le temps d'une session.</dd>
  <dt>Que dois-je faire après l'export ?</dt>
  <dd>Informer les personnes concernées dans le mois (article 14 du RGPD). Ce fichier n'est pas
  un fichier de prospection.</dd>
  <dt>Quelqu'un demande à être effacé</dt>
  <dd>« Oublier », replié sous sa carte de relecture : la donnée est supprimée, sa copie
  effacée, et elle ne reviendra pas.</dd>
</dl>
<p><a href="/aide?departement=${dept}">Lire le mode d'emploi complet</a></p>`;
}

const SUR_CET_ECRAN: Record<"preparer" | "collecter" | "relire" | "exporter", string> = {
  preparer: `<p>Ce qu'on règle avant de collecter : l'URL de contact, annoncée à chaque site
visité ; le département, sur la plaque en haut à gauche ; les numéros mobiles, exclus par défaut.
« Repartir de zéro », replié en bas, efface un département pour le recollecter à neuf — rien
n'est effacé au premier clic.</p>`,
  collecter: `<p>La collecte tourne sur cette machine, à raison d'une page toutes les deux
secondes par site. Le bloc de suivi s'actualise seul. Arrêter ne perd rien : relancer reprend
où elle s'est arrêtée. Vous pouvez relire pendant qu'elle travaille.</p>`,
  relire: `<p>Une carte à la fois, les moins sûres d'abord. Sous la valeur : ce qui a fait baisser
le score, et l'extrait de la page où elle a été lue.</p>
<dl>
  <dt>Valider <kbd>V</kbd></dt><dd>Le contact est juste. Il pourra sortir dans l'export.</dd>
  <dt>Rejeter <kbd>R</kbd></dt><dd>Faux ou hors sujet. Il reste en base mais ne sort pas.</dd>
  <dt>Corriger <kbd>C</kbd></dt><dd>Remplace la valeur ; la valeur lue reste dans la provenance.</dd>
  <dt>Oublier</dt><dd>Efface le contact et l'empêche de revenir aux collectes suivantes. Motif obligatoire, sans retour.</dd>
</dl>`,
  exporter: `<p>Le fichier simple tient en six colonnes, une ligne par structure, sans provenance.
Le fichier complet porte, pour chaque contact, la page d'où il vient, la date, la méthode et le
score : c'est celui qu'on garde pour répondre « d'où sort cette adresse ? ». L'aperçu montre les
premières lignes, telles que le fichier les portera.</p>`,
};
