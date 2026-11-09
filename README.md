# AGOA ML — boîte mail partagée

Application Windows (Electron) de l'agence Rémi Thollet Architecte : une boîte Gmail commune (`agence@remithollet.fr`) à laquelle
tout le monde accède, avec **rattachement aux immeubles et opérations**, **suivi par phases**, **notifications**, **notes par fil**,
**transmission d'un fil entre collaborateurs** et **fils « en attente » rouverts automatiquement** à l'arrivée des réponses.

- **Messages** : restent dans Gmail (source de vérité). Ragic ne garde que les métadonnées du fil.
- **Données** : base Ragic `agoa`, onglet `mails` (voir « Préparer Ragic »).
- **Connexions** : la clé Ragic et le compte Google viennent du **lanceur AGOA** (bouton CONNEXIONS) :
  variables `AGOA_RAGIC_KEY` / `AGOA_RAGIC_HOST` / `AGOA_RAGIC_APNAME` si l'application est lancée par le lanceur,
  sinon lecture de `C:\AGOA\_connexions\connexions.dat` (DPAPI).
- **Identification** : compte Google `@remithollet.fr` ; le compte doit voir la boîte partagée. L'application lit Gmail (`gmail.modify`) et envoie (`gmail.send`).

## Principes

- Un fil est rattaché à un **immeuble** (`DELTA14`) puis, si elle existe, à une **opération** (`DELTA14-A`, `DIDOT30-B2`). Détection par code dans l'objet (le plus long d'abord), puis par l'adresse de l'expéditeur.
- **Responsable effectif** = personne à qui le fil a été transmis, sinon architecte de l'opération (feuille OPERATIONS, champ « Architecte ? »).
- **Alias** (`etudes@`, `comptabilite@`, `secretariat@`) : un fil reçu sur un alias est attribué au collaborateur par défaut de la feuille *Alias*.
- **En attente** : à l'envoi d'une demande (ex. devis à 3 entreprises en Cci), le fil passe « En attente » avec la liste des réponses attendues. Une réponse, dans le fil ou dans un mail séparé d'un destinataire attendu, le repasse à « À traiter » et le rapproche.
- **Phases** (Visite, Rapport, Proposition d'honoraires, Étude, AO, Analyse AO, AG, PV AG, Chantier) et leurs statuts sont configurables dans Ragic. Chaque changement est enregistré dans *Avancement opérations*, **même si l'opération n'existe pas encore** dans Ragic ; à sa création, l'information est rattachée.
- **Règles de synchronisation** : phase + statut de phase → champ de la fiche OPERATIONS (Remplacer / Ajouter à la liste / Retirer de la liste ; `{date du jour}`, `{utilisateur}`).

## Préparer Ragic

Les champs sont retrouvés **par leur libellé exact** ; au démarrage, l'application liste ce qui manque. Voir `src/config.js` pour la liste complète.
Les listes (Réponses attendues, Notes, Journal, Fils rapprochés) sont des champs **texte long** contenant du JSON (pas de sous-tableaux).

| Feuille | Champs |
|---|---|
| **Mails** (`/mails/2`) | Thread ID, Objet, Expéditeur, E-mail expéditeur, Alias destinataire, Immeuble, Opération (texte), ID opération Ragic, Phase concernée, Statut (Nouveau / Urgent / A traiter / En attente / A valider / Traité), Pris en charge par, Relance, En attente depuis, Nb messages, Dernier message, Dernier expéditeur, Lien Gmail, **Colonne** (texte), Modifié par, Réponses attendues, Notes, Journal, Fils rapprochés |
| **Collaborateurs** | Nom, E-mail, Fonction, Valideur, Actif |
| **Phases** | Ordre, Libellé, Actif |
| **Statuts de phase** | Ordre, Libellé, Couleur, Statut système |
| **Alias** | Adresse, Collaborateur par défaut |
| **Avancement opérations** | Clé, Code opération, Immeuble, Phase, Statut de phase, Date, Mis à jour par, Fil (Thread ID), ID opération Ragic |
| **Règles de synchronisation** | Phase, Statut de phase, Champ OPERATIONS visé, ID du champ (facultatif), Action, Valeur, Actif |
| **Colonnes** (`/mails/10`, kanban) | Ordre (nombre), Libellé (texte), Couleur (Gris/Bleu/Orange/Violet/Vert/Rouge), Actif (case), Par défaut (case). Créer une ligne « To do » avec Actif et Par défaut cochés |
| **Notifications** | Clé, Pour, De, Date, Texte, Fil (Thread ID), Lue |

Chemins des feuilles : ajuster `src/config.js` (ou variable `AGOA_ML_PATHS`, JSON) une fois les feuilles créées.

## Développement

```
npm ci
npm test          # règles métier, Ragic (faux serveur), Gmail (faux), synchronisation
npm start         # Electron
npm run dist      # installateur Windows (NSIS)
```

## Google (une seule fois, administrateur Workspace)

Mêmes identifiants que AGOA TD : secrets `GOOGLE_CLIENT_ID` et `GOOGLE_CLIENT_SECRET` du dépôt (application de bureau, écran de consentement **Interne**),
avec les portées `gmail.modify` et `gmail.send`. En local : `resources/google-client.json` (ignoré par git).
