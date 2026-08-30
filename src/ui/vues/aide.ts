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

<p class="intro">Cet outil constitue <strong>l'annuaire des associations d'un departement</strong>.
Il part de deux fichiers publics — le registre national des associations et l'annuaire de
l'administration — puis va lire les sites des mairies du departement pour y trouver les adresses
et les telephones des associations. Chaque ligne produite porte l'adresse de la page ou elle a ete
lue, la date de lecture et une note de confiance : vous pouvez toujours remonter a la source.</p>

<p class="discret">Ce qu'il ne fait pas : envoyer des messages, consulter les reseaux sociaux, ni
transmettre quoi que ce soit a l'editeur de l'outil.</p>

<h2>Les cinq etapes</h2>

<ol class="marche">
  <li>
    <h3>Renseigner l'URL de contact — une fois pour toutes</h3>
    <p>Chaque page visitee recoit l'adresse d'une page ou vous joindre, pour qu'un webmestre de
    mairie puisse vous ecrire s'il a une question. <strong>Sans elle, rien n'est collecte</strong> :
    ce n'est pas un reglage, c'est une condition. Une page « contact » de votre collectivite convient.</p>
    <p class="discret">Ecran <a href="/?departement=${dept}">Synthese</a>, premier bloc.</p>
  </li>

  <li>
    <h3>Choisir le departement</h3>
    <p>La barre grise, en haut de chaque ecran. Tapez le code — <code>35</code>,
    <code>2A</code> en Corse, <code>971</code> outre-mer — puis « Ouvrir ». Un departement encore
    jamais collecte s'ouvre vide, et la barre le dit : c'est normal, l'etape suivante le remplira.</p>
    <p class="discret">Trois departements restent hors de portee : le 57, le 67 et le 68. Le droit
    local d'Alsace-Moselle place leurs associations dans un autre registre, que cet outil ne lit pas.</p>
  </li>

  <li>
    <h3>Lancer la collecte, et la laisser travailler</h3>
    <p>Bouton « Lancer le run complet ». <strong>Comptez plusieurs heures</strong>, parfois une
    journee sur un gros departement.</p>
    <p>Cette lenteur est voulue et ne se regle pas : l'outil attend <strong>deux secondes entre
    deux visites d'un meme site</strong>, pour ne pas peser sur des serveurs de mairie qui n'ont
    rien demande. Aller plus vite reviendrait a se faire bloquer, et a le meriter.</p>
    <p>Vous pouvez fermer la fenetre, eteindre le poste, revenir demain : <strong>tout reprend ou
    cela s'etait arrete</strong>. Rien n'est perdu et rien n'est refait deux fois.</p>
  </li>

  <li>
    <h3>Relire ce dont l'outil n'est pas sur</h3>
    <p>Ecran <a href="/revue?departement=${dept}">Revue</a>. On y trouve ce que l'outil n'a pas su
    trancher seul, <strong>les cas les moins surs en premier</strong> — c'est la que votre lecture
    apporte quelque chose. Chaque carte affiche ce qui a fait baisser la note, et un lien vers la
    page ou la valeur a ete lue : c'est ce lien qu'il faut ouvrir pour verifier.</p>
    <p class="discret">Cette etape n'est pas obligatoire. L'export fonctionne sans ; la revue
    ameliore le fichier, elle ne le conditionne pas.</p>
  </li>

  <li>
    <h3>Exporter le fichier</h3>
    <p>Ecran <a href="/export?departement=${dept}">Export</a>. Vous obtenez un fichier CSV, qui
    s'ouvre dans un tableur. Le « score minimum » filtre sur la confiance : <code>0.6</code> est un
    point de depart raisonnable, un champ vide sort tout, y compris ce dont l'outil doute.</p>
  </li>
</ol>

<h2>Avant de vous servir du fichier</h2>

<p>C'est la partie a ne pas sauter, et elle tient en une phrase :
<strong>ce fichier contient des donnees personnelles, et vous en etes responsable</strong> — pas
l'editeur de l'outil. C'est la consequence directe du fait que tout se passe sur votre machine :
c'est vous qui collectez.</p>

<p>Trois obligations concretes :</p>

<ul class="obligations">
  <li><strong>Informer les personnes concernees.</strong> Vous n'avez pas recueilli ces donnees
  aupres d'elles mais sur des sites publics. L'article 14 du RGPD vous oblige alors a les informer,
  dans un delai d'un mois, ou des votre premiere communication avec elles si elle vient avant.</li>

  <li><strong>Lire la colonne <code>regime</code> du fichier.</strong> <code>generique</code>
  designe une adresse de fonction — <code>contact@</code>, <code>mairie@</code> ;
  <code>nominatif</code> une adresse qui identifie une personne —
  <code>prenom.nom@</code> ; <code>indetermine</code> un cas que l'outil a refuse de trancher
  plutot que de deviner. Ces trois cas n'appellent pas les memes precautions.</li>

  <li><strong>Ce n'est pas un fichier de prospection.</strong> L'outil n'envoie aucun message et ne
  prepare pas de campagne. S'en servir pour demarcher est un autre traitement, avec ses propres
  regles, et il ne vous est pas fourni avec.</li>
</ul>

<p>Si une personne demande a etre effacee : le bouton <strong>« Oublier »</strong> de l'ecran de
revue. Il supprime la donnee, efface la copie de la page gardee en cache, et inscrit une exclusion
pour qu'elle ne revienne pas a la collecte suivante — sans quoi effacer ne durerait que jusqu'au
prochain run.</p>

<h2>Questions courantes</h2>

<dl class="faq">
  <dt>Rien ne bouge depuis vingt minutes. C'est bloque ?</dt>
  <dd>Probablement pas. Deux secondes entre chaque visite d'un meme site, sur des milliers de
  pages, cela fait des heures ou l'ecran avance a peine. La barre de progression et le compteur de
  jobs de l'ecran Synthese disent ce qui se passe reellement.</dd>

  <dt>Mon departement n'affiche que des zeros.</dt>
  <dd>Il n'a jamais ete collecte. La barre du haut l'indique. Lancez la collecte.</dd>

  <dt>Ou sont mes donnees ?</dt>
  <dd>Dans <code>${echapperHtml(donnees.dataDir)}</code>, sur cette machine. On y trouve la base,
  le cache des pages lues et le journal. Supprimer ce dossier efface tout le travail.</dd>

  <dt>Est-ce que quelque chose sort de mon poste ?</dt>
  <dd>Vers les sites des mairies, oui — c'est le travail de l'outil, et chaque visite annonce votre
  URL de contact. Vers l'editeur de l'outil, jamais : aucune mesure d'usage, aucun envoi.</dd>

  <dt>Et les numeros de portable ?</dt>
  <dd>Ecartes par defaut. Un 06 publie sur le site d'une commune est presque toujours la ligne
  personnelle d'un benevole, pas le telephone d'un local associatif. Une case permet de les
  conserver, avec ce que cela engage ; elle se remet a zero a chaque lancement de l'outil.</dd>

  <dt>Je veux un deuxieme departement.</dt>
  <dd>La barre du haut : tapez son code, puis lancez la collecte. Sachez que chaque departement
  relit le registre national en entier — 1,25 Go a chaque fois — car il n'est pas conserve sur
  votre disque.</dd>

  <dt>Puis-je collecter la France entiere d'un coup ?</dt>
  <dd>Non, et ce n'est pas un oubli. A deux secondes par site et environ 35 000 communes, une telle
  collecte durerait plusieurs jours sans interruption. L'outil travaille departement par
  departement.</dd>
</dl>
`;
}
