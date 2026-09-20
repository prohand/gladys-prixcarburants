# Prix carburants

Suivez le prix du carburant que vous utilisez dans les stations-service
proches de chez vous, directement dans Gladys : un appareil par station, un
historique de prix, et des scènes qui peuvent vous prévenir quand le plein
devient intéressant.

Les données proviennent de l'**open data officiel**. Aucun compte, aucune clé
d'API, aucun abonnement.

| Pays   | Source                                                                                             |
| ------ | -------------------------------------------------------------------------------------------------- |
| France | [prix-carburants.gouv.fr](https://www.prix-carburants.gouv.fr/rubrique/opendata/) (licence Etalab) |

D'autres pays pourront être ajoutés dans de prochaines versions : l'intégration
est construite autour d'un « fournisseur » par pays.

## Ce que vous obtenez

Pour **chaque station que vous ajoutez**, un appareil avec deux mesures :

- **Prix** — le prix au litre du carburant choisi, en euros. L'historique est
  conservé : Gladys trace la courbe du prix dans le temps.
- **Dernière mise à jour** — la date à laquelle la station a déclaré ce prix,
  affichée sous la forme `06/08/2026 à 07:12`, à l'heure locale de la station.
  Le flux national est rafraîchi toutes les 10 minutes environ, mais une
  station donnée ne change pas ses prix tous les jours : cette date vous dit
  quel âge a réellement le prix affiché au-dessus. Elle est relevée par station
  **et** par carburant : le gazole et le SP98 d'une même station ont chacun la
  leur.

L'adresse, la marque, les coordonnées GPS et la distance au code postal sont
enregistrées dans les paramètres de l'appareil.

### L'appareil « Prix carburants - Mise à jour des données »

En plus des stations, l'onglet Découverte propose **un appareil unique, commun
à toute l'intégration**, avec une seule mesure :

- **Dernière lecture des données** — la date et l'heure, au format
  `08/08/2026 à 21:00`,
  auxquelles l'intégration a lu le flux open data pour la dernière fois **avec
  succès**.

C'est une information différente de la « Dernière mise à jour » d'une station :
celle-ci vous dit quand la station a bougé ses prix (ce qui peut remonter à une
semaine, tout à fait normalement), celle-là vous dit si l'intégration arrive
encore à joindre l'API nationale. Si cette date se met à vieillir alors que
votre intervalle de rafraîchissement est d'une heure, c'est que la source de
données ne répond plus.

Cet appareil est facultatif : ne l'ajoutez pas et l'intégration fonctionne
exactement pareil. Ajouté, il est mis à jour à la fin de chaque
rafraîchissement, et il reste vide tant qu'aucune lecture n'a encore réussi.

L'appareil porte le nom de l'enseigne de la station et de sa commune, par
exemple `Total Access - Oullins-Pierre-Bénite - SP98`. Le flux national des prix
ne publie pas cette enseigne : elle est lue dans un jeu de données de référence
du même système d'information. Une station que ce jeu de données ne connaît pas
garde un nom construit à partir de sa rue.

## Configuration

1. Ouvrez l'onglet **Configuration** de l'intégration.
2. Choisissez votre **pays** (France pour l'instant).
3. Renseignez votre **code postal** (5 chiffres en France, par exemple
   `35000`). C'est autour de lui que les stations sont cherchées.
4. Réglez le **rayon de recherche** : `0` ne garde que les stations du code
   postal lui-même, `10` km élargit aux communes voisines. Un code postal sans
   station-service ne pose pas de problème : la recherche est quand même
   centrée sur votre commune, les pompes de la commune d'à côté apparaissent.
5. Cochez le ou les **types de carburant** qui vous intéressent : Gazole,
   SP95, SP98, E10, E85, GPLc.
6. Enregistrez.

Le bouton **Prévisualiser les stations proches** affiche immédiatement ce que
la recherche renvoie, avec les prix actuels — pratique pour ajuster le code
postal ou le rayon avant d'ajouter quoi que ce soit.

## Ajouter des stations

Ouvrez l'onglet **Découverte** : les stations trouvées y apparaissent, une
entrée par station **et** par carburant sélectionné, par exemple
« TotalEnergies - Rennes - Gazole » et « TotalEnergies - Rennes - SP98 ».
Cliquez sur **Ajouter** pour celles que vous voulez suivre : une seule,
plusieurs, ou toutes.

Seules les combinaisons réellement disponibles sont proposées : une station
qui ne vend pas de GPLc n'apparaît pas dans la liste GPLc.

Une fois ajoutée, la station publie son prix immédiatement, puis à chaque
rafraîchissement (une fois par heure par défaut). Le rythme est celui de
l'**Intervalle de rafraîchissement** de l'onglet Configuration : l'intégration
gère elle-même son minuteur, l'appareil n'affiche donc pas d'option
d'interrogation côté Gladys. Le bouton **Rafraîchir les prix maintenant** force
une lecture sans attendre.

## Supprimer des stations

Ouvrez l'appareil dans **Réglages → Appareils**, puis **Supprimer**.
L'intégration cesse aussitôt de l'interroger. La station reste visible dans
l'onglet **Découverte** tant qu'elle correspond à votre recherche : vous
pouvez la ré-ajouter plus tard.

Supprimer un carburant d'une station n'affecte pas les autres : « Rennes -
Gazole » et « Rennes - SP98 » sont deux appareils indépendants.

## Changer de carburant plus tard

Un appareil Gladys conserve les mesures avec lesquelles il a été créé. Le
carburant fait donc partie de l'identité de l'appareil : si vous cochez un
carburant supplémentaire dans la configuration, de **nouvelles** entrées
apparaissent dans l'onglet Découverte, et vos appareils existants continuent
de fonctionner sans être modifiés. Supprimez ceux dont vous n'avez plus
besoin.

## Idées de scènes

- Recevoir une notification quand le prix du gazole de votre station passe
  sous un seuil.
- Comparer deux stations sur le tableau de bord avant de partir faire le
  plein.
- Enregistrer le prix moyen du mois grâce à l'historique.

## Déclencheurs de scènes

Sur une version de Gladys qui le gère, l'intégration ajoute trois déclencheurs
dans la catégorie **Intégrations** de l'éditeur de scènes. Ils apparaissent tout
seuls : rien à configurer côté intégration.

| Déclencheur                                  | Se déclenche quand                                                                                       |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **Un prix de carburant a changé**            | une station que vous suivez a déclaré un nouveau prix (filtres : station, carburant, hausse ou baisse)   |
| **La station la moins chère a changé**       | une autre de vos stations est devenue la moins chère pour un carburant (il faut en suivre au moins deux) |
| **Le flux open data est devenu injoignable** | toutes les stations d'un rafraîchissement ont échoué, ou le flux répond de nouveau                       |

Chaque déclencheur transmet des informations à vos actions : le nom de la
station, la ville, le carburant, le nouveau prix, le prix précédent et l'écart.
Exemple de notification : « Le Gazole passe à 1,659 € à Station du Centre
(-0,040 €) ».

Un filtre laissé vide veut dire « peu importe » : sans station choisie, le
déclencheur réagit à toutes vos stations.

Deux points à connaître :

- **un prix qui ne bouge pas ne déclenche rien**, même si l'intégration
  rafraîchit toutes les heures : seul un vrai changement est envoyé ;
- après un redémarrage du conteneur, le premier rafraîchissement sert de point
  de repère et n'envoie rien.

Pour un simple seuil (« préviens-moi sous 1,70 € »), n'utilisez pas ces
déclencheurs : le déclencheur **Un appareil change d'état** de Gladys, sur la
donnée « prix » de la station, fait déjà exactement ça.

## Actions de scènes

Toujours dans la catégorie **Intégrations**, l'intégration ajoute trois actions
utilisables dans une scène.

| Action                                 | Ce qu'elle fait                                                                   |
| -------------------------------------- | --------------------------------------------------------------------------------- |
| **Rafraîchir les prix des carburants** | lit le flux maintenant, pour que la suite de la scène travaille sur un prix frais |
| **Trouver la station la moins chère**  | compare vos stations pour un carburant et renvoie la moins chère                  |
| **Préparer un résumé des prix**        | la même comparaison sous forme d'une ligne de texte prête à envoyer               |

Les résultats d'une action sont réutilisables dans les étapes suivantes de la
scène (prix, nom de la station, ville, adresse, distance, date du prix…).

Exemple de scène, tous les matins à 7 h :

1. **Trouver la station la moins chère** (carburant : Gazole, lire les prix
   avant de comparer : oui) ;
2. **Continuer seulement si** le résultat `found` est vrai ;
3. **Envoyer un message** : « Le plein le moins cher : {{ nom de la station }} à
   {{ prix }} €/L ».

Ou plus court, en une seule étape : **Préparer un résumé des prix**, puis
envoyer le texte obtenu.

Bon à savoir : « Trouver la station la moins chère » ne fait jamais échouer la
scène quand vous ne suivez aucune station pour ce carburant — elle répond
`found = false`, et c'est à vous de tester ce résultat.

## Dépannage

**Aucune station dans l'onglet Découverte.** Vérifiez le code postal (5
chiffres en France) et augmentez le rayon de recherche. Le bouton
**Prévisualiser les stations proches** affiche le message d'erreur exact.

**Le prix ne se met plus à jour.** Une station peut disparaître temporairement
du flux national (travaux, fermeture). Le dernier prix connu reste affiché ;
consultez les logs de l'intégration, qui indiquent les stations manquantes.

**Un prix vide.** La station ne déclare pas ce carburant en ce moment.
L'intégration conserve alors la dernière valeur connue plutôt que de trouer la
courbe.

**Le SP95 d'une station n'apparaît pas, contrairement au SP98.** C'est la
station qui ne vend pas de SP95, pas un bug : beaucoup d'enseignes
(TotalEnergies en particulier) l'ont remplacé par le **E10 (SP95-E10)**.
Cochez E10 dans la configuration et la station réapparaîtra dans l'onglet
Découverte. Le bouton **Prévisualiser les stations proches** le dit
station par station : « SP95 : non vendu ».

**Nombre de stations limité.** Le réglage **Nombre maximum de stations** borne
la liste de découverte (20 par défaut, 50 au maximum). En ville dense,
baissez-le et réduisez le rayon.

**Une station précise n'apparaît pas.** La liste retient les stations les plus
PROCHES, dans la limite de ce maximum : en ville, vingt stations tiennent dans
deux kilomètres, une station à 5 km est donc écartée même avec un rayon de
10 km. Augmentez le **Nombre maximum de stations** plutôt que le rayon. Une
station qui ne déclare aucun prix pour le carburant coché n'est pas proposée
non plus, l'appareil n'aurait rien à publier.

## Données et licence

Les données sont publiées par le ministère de l'Économie sous
[licence Etalab](https://www.etalab.gouv.fr/licence-ouverte-open-licence).
L'intégration interroge le
[jeu de données « flux instantané »](https://data.economie.gouv.fr/explore/dataset/prix-des-carburants-en-france-flux-instantane-v2/)
et ne récupère que les stations autour de votre code postal. Quand ce jeu de
données ne connaît aucune station dans votre code postal, la position de votre
commune est lue dans la
[Base Adresse Nationale](https://adresse.data.gouv.fr/), le service d'adresses
officiel — seul le code postal lui est transmis.
