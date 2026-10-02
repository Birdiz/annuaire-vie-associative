// Raccourcis de la carte de relecture (ADR-041) : V valide, R rejette, C corrige.
//
// Facultatifs, et c'est voulu : tout se fait aussi a la souris, et sans JavaScript du
// tout — chaque bouton est un vrai bouton d'un vrai formulaire. Ce fichier ne fait que
// cliquer a la place de la personne. Il est servi depuis cette machine comme htmx : la CSP
// refuse tout script en ligne, et un `hx-on` demanderait d'evaluer du code, ce qu'elle refuse aussi.
"use strict";
document.addEventListener("keydown", function (evenement) {
  if (evenement.ctrlKey || evenement.metaKey || evenement.altKey || evenement.repeat) return;
  var cible = evenement.target;
  // Une lettre tapee dans un champ est une lettre, pas une decision.
  if (cible instanceof HTMLElement && (cible.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(cible.tagName))) return;
  var touche = evenement.key.toLowerCase();
  var bouton = document.querySelector('#atelier [data-raccourci="' + touche + '"]');
  if (!(bouton instanceof HTMLButtonElement) || bouton.disabled) return;
  evenement.preventDefault();
  bouton.click();
});
