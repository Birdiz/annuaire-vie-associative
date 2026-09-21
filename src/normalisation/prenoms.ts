/**
 * Prenoms frequents en France. **Fichier genere** par `node scripts/prenoms.ts` : ne pas
 * le modifier a la main, le regenerer.
 *
 * Il sert a une seule question — ce segment nomme-t-il une personne ? — et c'est ce qui
 * justifie son poids (ADR-036) : sans lui, « Christophe Durand » ne se distingue pas de
 * « Trail Urbain », ni « Pierre » seul d'un nom de club.
 *
 * Source : INSEE, Fichier des prénoms, édition 2025 (naissances 1900-2025), Licence Ouverte 2.0. Effectifs cumules sur toutes les annees, prenoms d'au moins
 * 2000 naissances, normalises (minuscules, sans accents), composes exclus — leurs
 * parties y sont —, et sans les prenoms qui sont aussi des mots de structure (voir
 * `EXCLUS` dans le script).
 *
 * Un test recalcule `PRENOMS_SHA256` : une retouche a la main, accidentelle ou non, fait
 * echouer `npm run check` plutot que de passer inapercue dans une liste que personne ne
 * relit.
 */
export const PRENOMS_SOURCE = "INSEE, Fichier des prénoms, édition 2025 (naissances 1900-2025), Licence Ouverte 2.0";
export const PRENOMS_SOURCE_SHA256 = "5ec80c06cd9266cc5680885c6a219148bcdfaa53d65086f4ea9d2c584431fbfd";
export const PRENOMS_SEUIL = 2000;
export const PRENOMS_SHA256 = "871f472c41b5968cc0fa7352245862f4f7e33bec472e4b63d3fc0e7d2626c0a4";

export const PRENOMS = `
aaliyah aaron abby abdallah abdel abdelaziz abdelkader abdelkrim abdellah abderrahmane abdoul
abdoulaye abel abigael abigaelle abigail aboubacar abraham achille achraf adam adama adel
adelaide adele adelie adelina adeline adem adil adolphe adolphine adonis adrian adriana adriano
adrien adrienne aelys agathe aglae agnes ahmed ahmet aicha aida aidan aiden aime aimee aina
aisha aissa aissata aissatou akim akram aksel alain alan alana alba alban albane albert alberte
albertine alberto albin alcide aldo alec alessandro alessia alessio alex alexa alexander
alexandra alexandre alexandrine alexane alexia alexiane alexis alexy aleyna alfred alfreda ali
alia alice alicia alida alienor aliette alina aline alison alissa alisson alix aliya aliyah
alize alizee allain allan allison alma alois aloise aloyse alphonse alphonsine alya alyah alycia
alyson alyssa alyssia amadou amael amal amalia amand amanda amandine amar amara amaury amaya
ambre ambrine ambroise amedee amel amelia amelie ameline amin amina aminata amine amir amira amy
ana anabelle anae anael anaelle anais anas anass anastasia anastasie anatole anaya andre andrea
andreas andree andrew andy anes ange angel angela angele angelina angeline angelique angelo
angie ania anicet anick anis anissa anita anna annabel annabelle annaelle anne annette annick
annie annik anny anouar anouck anouk anselme anthony antoine antoinette anton antonia antonin
antonine antonio antony anya apolline appoline april aria ariane ariel arielle aristide arlette
armand armande armandine armel armelle arnaud arno arnold aron arsene arthur arwen arya ashley
asma asmaa assa assia assil assiya assya astrid astride asya athena athenais aubin aude audrey
augusta auguste augustin augustine aurele aurelia aurelie aurelien auriane ava awa axel axelle
aya ayan ayana aydan ayden ayla aylan aylin ayline ayman aymane aymen aymeric ayna ayoub ayse
aziz aziza azra bachir badis balthazar baptiste baptistine barbara barbe barthelemy basile basma
bastian bastien baya beatrice beatrix belinda bella ben benedicte benjamin benoit berangere
berengere berenice bernadette bernard berthe bertille bertrand bettina betty bianca bilal bilel
billie billy bintou blaise blanche blandine boris bouchra bradley brahim brandon brayan brenda
brian brice brieuc brigitte bruce brune bruno bryan cali calie calista calixte calvin camelia
cameron camil camila camilia camille candice candy capucine carine carl carla carlos carmen
carol carole caroline casimir cassandra cassandre cassie cassy castille cataleya catherine
cathie cathy cecile cecilia cedric cedrick celeste celestin celestine celia celian celina celine
celya cendrine cesar chahine chaima chanel chantal chantale charlene charles charlette charlie
charline charlize charlotte charly charlyne chayma chelsea cherif cherine cheyenne chiara chloe
chris christel christele christelle christian christiane christianne christina christine
christophe christopher chrystel chrystele chrystelle cindy claire clara clarence clarisse claude
claudette claudia claudie claudine claudius claudy clea clelia clemence clement clementine cleo
cloe clotaire clothilde clotilde clovis colette colin coline colombe come constant constantin
coralie coraline corentin corine corinne coumba cristelle cristina curtis cynthia cyprien
cyriaque cyrielle cyril cyrille daisy dalia dalila damien dan dana dania daniel daniela daniele
daniella danielle danny dany daphne daphnee dario darius david davina davy deborah delia
delphine denis denise deniz desire desiree diana diane didier diego dimitri dina djamel djamila
djibril dolores dominique domitille donatien donia donovan dora dorian doriane dorine doris
dorothee dounia driss dylan eddie eddy eden edgar edgard edith edithe edmee edmond edmonde
edouard edward edwige edwin eglantine eileen ela elaia elea eleana eleanor eleanore elena
eleonore eli elia elian eliana eliane elianne elias elie eliette elif elijah elina eline elio
eliot eliott elisa elisabeth elise elisee eliza elizabeth ella ellie elliot elliott eloan eloane
elodie eloi eloise elona elora elouan elsa elvire elvis elya elyana elyas elyes elyna elyne elyo
ema emelie emeline emelyne emeric emie emile emilia emilie emilien emilienne emilio emily emir
emma emmanuel emmanuelle emmie emmy emna emre emy enael enea enes enola enora enrique enzo eren
eric erick erik erika erin erine erna ernest ernestine erwan erwann erwin esma esmee esra
esteban estelle esther ethan etienne etiennette eugene eugenie eulalie euphrasie eva evan evann
eve eveline evelyne evy ewan ewen ewenn eyden eymen ezechiel ezekiel ezio ezra fabian fabien
fabienne fabio fabiola fabrice fadila faiza fanny fanta fantine fany farah fares farid farida
fatih fatiha fatima fatma fatou fatoumata faustin faustine faycal felicia felicie felicien
felicienne felicite felix ferdinand fernand fernande fernando filipe fiona firdaws firmin flavie
flavien flavio fleur flora flore florence florent florentin florentine florian floriane florie
florine fortune fouad fouzia francesca francesco francette francine francis francisca francisco
francisque franck francky franco francois francoise frank frantz fred freddy frederic frederick
frederique fredy frieda gabin gabriel gabriela gabriella gabrielle gaby gael gaelle gaetan
gaetane gaia garance gary gaspard gaston gatien gauthier gautier gaylord genevieve geoffrey
geoffroy george georges georgette georgina gerald geraldine gerard geraud germain germaine
gertrude gervais ghislain ghislaine ghyslaine gianni gil gilbert gilberte gilda gildas gilles
gillette gina ginette gino giovanna giovanni gisele giselle gislaine giulia giulian giuliana
giuseppe gladys gloria grace gracieuse graziella gregoire gregory guilaine guilhem guillaume
guillemette gurvan gustave guy guylaine guylene gwenael gwenaelle gwendal gwendoline gwenola
gwladys habib habiba hadrien hafida hafsa hajar hakim hakima halima hamed hamid hamza hana hanae
hanane hanna hannah hans harold haroun harry hasan hasna hassan hawa hayat hayden hector hedi
heidi helena helene heloise henri henriette henry hermance hermann hermine herve hiba hicham
hichem hidaya hilaire hind hippolyte hocine honore honorine hortense houda houria hubert hugo
hugues huguette hyacinthe ian iban ibrahim ibrahima ida idris idriss ignace igor ikram ilan
ilana ilham ilhan ilian iliana ilias ilies illan ilona ilyan ilyana ilyas ilyes imad iman imane
imen imene imran imrane inaya ines ingrid irena irene irenee irina iris irma isaac isabel
isabelle isaiah isaline isaure ishak ishaq isidore isis islem ismael ismail isra israa issa
issam ivan ivana iyad iyed izia jack jacki jackie jacky jacob jacqueline jacques jacquy jad jade
jaden jamal jamel james jamila jana jane janelle janick janine janna jannah jannick jany jarod
jasmine jason jassim jawad jayden jayson jean jeanine jeanne jeannette jeannick jeannie jeannine
jeannot jeffrey jenna jennah jennifer jenny jennyfer jeremie jeremy jerome jessica jessie jessim
jessy jesus jibril jihane jim jimmy joachim joan joana joanna joanne joannes joanny joao joaquim
jocelyn jocelyne jodie joe joel joelle joey joffrey johan johana johann johanna johanne john
johnny johny jolan jonah jonas jonathan jordan jordane jordy jorge joris jose josee joseline
joselyne joseph josepha josephe josephine josette joshua josiane josianne josselin josseline
josselyne josue josyane joud joy joyce juan jude judicael judith jules julia julian juliana
juliane juliann julie julien julienne juliette juline julio june justin justine kadiatou kahina
kaina kais kamal kamel kamelia kamil kamila karen karim karima karin karina karine karl
kassandra kassim katell kathleen kathy katia katy kayden kayla kays kelia kelian kelly kelya
kelyan kenan kenny kenza kenzo kessy ketty kevin keziah khadidja khadija khaled khalid khalil
kheira kiara kilian killian kilyan kim kimberley kimberly klara kleber kyara kyle kylian kyllian
laeticia laetitia lahna laila laina lalie laly lambert lamia lamine lana landry lara lassana
latifa laura laure laureen laureline lauren laurence laurene laurent laurette lauriane laurianne
laurie laurine laury lauryn lauryne laya layana layla layna lazare lea leana leandre leandro
leane leanne leelou leeroy leia leila leina lena lenaic leni lenny leny lenzo leo leocadie leon
leona leonard leonardo leonce leone leonie leonne leonor leonore leontine leopold leopoldine
leslie lesly levi lewis lexie leya leyla leyna lia liam liana lidia lila lilas lili lilia lilian
liliane lilianne lilie lilly lilou lilwenn lily lilya lina linda lindsay line lino lionel
lionnel lisa lisandro lise lisette lisiane lison liv livia livio liya liza lizea loan loane
loann loanne loetitia loevan logan lohan loic loick lois loise lola lolita lorelei lorena lorene
lorenzo lorette loriane lorie lorine loris lorraine lou louane louann louanne loubna louca
loucas louis louisa louise louisette louison louka loukas louna lounes loup luana lubin luc luca
lucas luce lucette lucia luciano lucie lucien lucienne lucile lucille lucy ludivine ludovic
ludwig luigi luis luisa luka lukas luna lya lyah lyam lyana lyanna lydia lydie lyes lyla lylia
lylian lyliane lylou lyna lynda lyne lysa lysandre lyse lysiane maceo maddy madeleine madeline
madison mady mae mael maela maelan maelia maelie maeline maelis maelle maely maelya maelyne
maelys maena maeva magali magalie magaly magdalena magdeleine maggy maguy mahamadou mahaut mahdi
mahe maia maily mailys maimouna maina maissa maissane maite maiwen maiwenn malak malek malia
malick malik malika mallaury mallory malo maloe malone malorie malory malvina malya mamadou
mandy manel manelle manoa manoe manon manuel manuela manuella marc marceau marcel marcelin
marceline marcelle marcellin marcelline marco marcus margaret margaux margo margot marguerite
maria mariam mariama mariame marian mariana mariane marianne marie marielle mariette marilou
marilyn marilyne marin marina marinette mario marion marius marjolaine marjorie mark marlene
marley marlon marouane martha marthe martial martin martine marvin marwa marwan marwane mary
maryam marylene maryline marylise marylou maryne maryse maryvonne mateo matheo mathias mathieu
mathilda mathilde mathis mathurin mathys matias matis matisse matt matteo mattheo matthew
matthias matthieu matthis mattia mattis matys maud maude maureen maurice mauricette maurine max
maxence maxim maxime maximilien maximin maxine maya mayeul mayline maylis maylone mayron mayssa
mederic medhi medina medine megane mehdi mehdy mehmet melanie melek melia melina melinda meline
melisa melissa mellina melodie melody melvin melvyn melya melyna melyne melyssa mercedes meriem
merlin meryem meryl mia michael michel michele micheline michelle mickael miguel mikael mikail
mike mila milan milann milena milhan milla milo mina mira mireille mirella miya mohamed mohammad
mohammed moise mona monia monica monique morad morgan morgane mouhamed mouna mounia mounir
mourad moussa moustapha muguette muhammad muhammed murat muriel murielle mustafa mustapha mya
myla mylan mylann mylene myriam nabil nabila nada nadege nadia nadine nadir nael naelle nahel
nahil naia nail naila naim naima nais nancy naomi naomie narcisse nasser nassera nassim nassima
natacha natalia natan nathael nathalie nathan nathanael nathaniel nawal nawel naya nayla neil
neila nelia nell nelly nelson nelya neo nesrine nestor neyla nicolas nicole nicolle niels nils
nina nino ninon nisrine nizar noa noah noam noan noe noel noele noelia noelie noeline noella
noelle noemie noha noham nohan nola nolan nolann nolhan nolwenn noor nora norah norbert nordine
nour noura oceane octave octavie odette odile olga olive oliver olivia olivier olympe omar
ombeline omer ophelia ophelie orane oriane orianne orlane ornella oscar othman oumar oumou
ousmane oussama owen pablo paco pacome palmyre paloma pamela paola paolo pascal pascale
pascaline patrice patricia patrick paul paula paule paulette paulin pauline paulo pedro peggy
penelope perle perrine peter pharell philibert philippe philippine philomene pia pierre
pierrette pierrick pierrot pol prescillia prisca priscilla priscille priscillia prosper prune
qassim quentin rabah rabia rachel rachelle rachid rachida rafael rahma raissa rania raoul
raphael raphaele raphaelle rayan rayane raymond raymonde raynald rebecca reda redouane regina
regine regis reine rejane remi remy renald renan renaud rene renee reynald riad ricardo richard
rim rita riyad robert roberte roberto robin roch rodolphe rodrigue roger roland rolande rolland
rollande romain roman romane romaric romeo romuald romy ronald ronan rosa rosalie rose roseline
roselyne rosemonde rosette rosie rosine rosita roxane roxanne rozenn ruben ruby ruddy rudy ruth
ryad ryan rym saad sabah sabine sabri sabrina sabrine sacha safa safia safiya sahra said saida
sakina salah saliha salim salima salma salome salvador salvatore sam samantha samba sami samia
samir samira samson samuel samy sana sanaa sandie sandra sandrine sandro sandy santiago sara
sarah sasha sauveur savannah sean sebastian sebastien segolene sekou selena selene selim selma
sephora seraphin seraphine serena serge sergine sergio servane sevan severin severine shaima
shaina shana shanna shannon sharon shayna sherine shirley sibylle sidney sidonie sienna siham
sihem silvia simeon simon simone simonne sindy sirine sixtine slimane soan soen sofia sofian
sofiane sohan sohane soizic solal solange solene solenn solenne soline sonia sonny sophia sophie
soraya soren souad soufiane soukaina souleyman souleymane soumaya stacy stan stanislas
stanislawa stanley stecy steeve steeven stefan stella stephan stephane stephanie stephen stessy
steve steven sullivan sully suzanne suzette suzie suzy swan swann sybille sydney sylvain
sylvaine sylvestre sylvette sylvia sylviane sylvianne sylvie syrine tahar taina talia talya
tamara tanguy tania tao tara tarek tarik tasnim tasnime tatiana tea teddy teo terence terry
tesnim tess tessa thais thalia thea thelma theo theodore theophile theresa therese thiago
thibaud thibault thibaut thierry thimeo thomas thymeo tia tiago tiana tidiane tifenn tiffanie
tiffany tilio tim timeo timote timothe timothee timothy tina tino tiphaine tiphanie titouan
tobias tom tomas tommy tomy toni tony toufik toussaint tracy tristan tyler tylio tymeo typhaine
tyron ugo ulrich ulysse urbain ursule vadim valentin valentina valentine valentino valere
valerian valerie valery vanessa vanina veronique vianney vicky victor victoria victorien
victorine vincent vincenzo violaine violette virgil virgile virginia virginie vital vivian
viviane vivien vladimir wael wail walid walter wanda warren wassila wassim wendy wesley wilfrid
wilfried william williams willy wilson wissam wissem wyatt xavier yacine yael yaelle yahya
yamina yan yanick yanis yaniss yann yannick yannis yara yasin yasmina yasmine yasser yassin
yassine yassir yazid ylan ylann yoan yoann yohan yohann yolaine yolande yona yoni youcef youenn
youna younes youness youri yousra youssef youssouf youssra ysee yuna yusuf yvan yveline yves
yvette yvon yvonne zacharie zachary zack zahra zakaria zakariya zakarya zayd zayn zaynab zelia
zelie zeynep ziad zina zineb zinedine ziyad zoe zohra
`.trim().replace(/\s+/g, " ");
