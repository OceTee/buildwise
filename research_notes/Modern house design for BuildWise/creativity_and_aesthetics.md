# Architectural Creativity and the Aesthetics of House Design (for the BuildWise design engine)

Scope note: about 18 searches and fetches. Several key pages could not be fetched (RIBA Journal 403, the Merri-bek advice sheet blocked, the gov.uk NMDC HTML page failed, a Substack on material counts returned 404). Where a claim rests only on a search-result snippet rather than a fetched page, it is marked "(snippet)". Canonical book claims (Ching, Alexander, Venturi, Pallasmaa, Vitruvius) are cited to the closest primary or secondary page found, not to the books themselves.

## 1. How architects describe the design process and creativity (concept / parti, drivers, iteration, multiple options, rules vs breaking rules, constraint as a source of creativity)

### Takeaway
Architects rarely analyse first and synthesise second. They seize one simple organising idea early (Darke's "primary generator"), sketch a crude design around it, test it, and revise. Several alternative strategies are normally developed and compared with the client before one is chosen. Computational practice formalises this as "generate a spectrum of options, score each against criteria, and enforce diversity between options."

### Cited Findings
- Concept design "implies an idea, or range of ideas, a development approach, a guiding concept and a design intent". It settles "what" and "how much" before "how". — [Designing Buildings Wiki: Concept architectural design](https://www.designingbuildings.co.uk/wiki/Concept_architectural_design)
- The same source: concept design "is seldom a 'Eureka!' moment where a single idea pops into the head which resolves everything". It comes from prioritisation and discussion. The architect "may, in discussion with the client, generate several alternative strategies for developing a site, exploring the advantages and disadvantages of various options and then agreeing the best way forward." — [Designing Buildings Wiki](https://www.designingbuildings.co.uk/wiki/Concept_architectural_design)
- Jane Darke interviewed British architects designing local-authority housing. She found they "latch on to a relatively simple idea very early in the design process", which she called the *primary generator*. Her model is generator → conjecture → analysis, replacing analysis → synthesis: "first decide what you think might be an important aspect of the problem, develop a crude design on this basis and then examine it." — reported in Bryan Lawson, *How Designers Think* (4th ed. 2005), via [academia.edu copy](https://www.academia.edu/1905966/How_Designers_Think) and [Petra University excerpt](https://uop.edu.jo/PDF%20File/petra%20university%20[Architecture_Ebook]_How_Designers_Think_-_The_Design_Process_Demystified-20603-Part30.pdf) (snippet)
- Lawson cites Rowe (1987) drawing-based studies showing reasoning organised around "a synthetic, highly formative idea" rather than problem analysis. He also criticises the purely sequential view as "rather unconvincing", concedes that primary generators are not always singular, and frames design as a negotiation between problem and solution through analysis, synthesis and evaluation. — [Lawson, How Designers Think (academia.edu)](https://www.academia.edu/1905966/How_Designers_Think) (snippet)
- Architectural design "typically involves multiple competing design objectives" (example: team communication against individual privacy). Architects have traditionally handled these trade-offs "qualitatively, relying on intuition and experience". — [Google Patent US11409920, Generative design for architecture](https://patents.google.com/patent/US11409920)
- The same patent describes a design engine that "generate[s] a spectrum of design options for a structure based on project constraints" and occupant criteria, then produces "a set of metrics that indicates how well the given design option meets the multiple design criteria." — [US11409920](https://patents.google.com/patent/US11409920)
- A thesis on the IDEA tool proposes that designers "sort design options into clusters" by similarity of form, and turns this into a *diversity metric* used to generate diverse options that still satisfy the objective. Multi-objective solvers provide "a spectrum of possible solutions". — [core.ac.uk thesis PDF](https://core.ac.uk/download/9342443.pdf) (snippet)
- Ching names *transformation* as an ordering principle: "an architectural concept, structure or organisation can be altered through a series of discrete manipulations and permutations in response to a specific context or set conditions without loss of identity of the concept". This is the formal basis for "variants of one parti". — [Designing Buildings Wiki: Principles of Order in Architecture](https://www.designingbuildings.co.uk/wiki/Principles_of_Order_in_Architecture); [Ching ch.7 PDF (archive.org)](https://archive.org/download/ArchitectureFormSpaceAndOrderCh7/Architecture_Form%20Space%20and%20Order_Ch7.pdf)
- Rule-breaking as a design stance: Venturi's *Complexity and Contradiction in Architecture* (1966) favours elements that are "both-and" rather than "either-or". A both-and element "poses two contradictory characteristics simultaneously". "The source of the both-and phenomenon is contradiction, and its basis is hierarchy." — [Mount Holyoke architecture blog on Venturi](https://commons.mtholyoke.edu/architectualblog/?p=2); [On Architecture Substack book reflection](https://onarchitecture.substack.com/p/book-reflection-complexity-and-contradiction)
- Counterpoint: Jonathan Ochshorn (2024, *Agathón*) challenges the idea that complex building geometries reflect the complexity of contemporary life. He critiques both Venturi and later computational-complexity writing. — [DOAJ: Agathón Dec 2024](https://doaj.org/article/41ac39b40cbd4f0ba5728eb631517e98)

### Inferences
- For BuildWise, every generated option should have a named *primary generator* or parti: one sentence such as "courtyard house around a shaded court", "L-plan with living wing to the street", or "long bar facing the breeze". Options should differ in that idea, not only in dimensions. This matches the existing `ConceptCard` (name, story, moves).
- "Multiple options" should be enforced with an explicit diversity check, such as clustering by massing or typology, so the four `MAX_DESIGNS` are not near-duplicates. This mirrors the IDEA diversity metric.
- Generator → conjecture → test maps onto the engine: pick a driver (site, climate, programme, culture), lay out, run `checkDesign`/`reviewDesign`, and revise. The AI designer's "send failing options back once with the problems" loop already follows this pattern.
- Transformation (Ching) supports producing variants as manipulations of one parti, such as rotate, mirror, extrude a wing, or add a court, while keeping its identity.

### Gaps
- No fetched source defined *parti* directly. A targeted source such as a studio glossary or Ching's design-process writing is still needed.
- No source was found on "constraint as a source of creativity" in architecture. Searches did not reach this topic, so it remains unsourced.
- Explicit lists of design drivers (site, climate, programme, culture) were not found in an authoritative source beyond the general "competing objectives" framing.

## 2. Aesthetic principles: proportion, rhythm, hierarchy, balance, solid–void, base–middle–top, depth/shadow, roofscape, material palette, colour

### Takeaway
The ordering principles canonised by Ching are axis, symmetry, hierarchy, datum, rhythm/repetition and transformation. Proportion systems (Palladio's seven room shapes, the golden section, Le Corbusier's regulating lines and Modulor) were applied selectively, not dogmatically. Planning codes turn these into concrete rules: a differentiated base, middle and top on taller buildings; vertical rhythm of bays; recessed windows for shadow; a limited, locally appropriate material palette; and controlled glazing ratios.

### Cited Findings
**Ordering principles (Ching, *Architecture: Form, Space, and Order*, ch. 7)**
- Axis: "Although imaginary and not visible except to the mind's eye, an axis can be a powerful, dominating, regulating device". "An axis must be terminated at both of its ends by a significant form or space." — [Ching ch.7 PDF](https://archive.org/download/ArchitectureFormSpaceAndOrderCh7/Architecture_Form%20Space%20and%20Order_Ch7.pdf)
- Hierarchy: "A form or space may dominate an architectural composition by being significantly different in size from all the other elements" (Ching also lists unique shape and strategic location). — [Ching ch.7 PDF](https://archive.org/download/ArchitectureFormSpaceAndOrderCh7/Architecture_Form%20Space%20and%20Order_Ch7.pdf); [Designing Buildings Wiki](https://www.designingbuildings.co.uk/wiki/Principles_of_Order_in_Architecture)
- Datum: "a line, plane or volume which, by its continuity and regularity, serves to gather, measure and organise a pattern of forms and spaces." — [Designing Buildings Wiki](https://www.designingbuildings.co.uk/wiki/Principles_of_Order_in_Architecture)
- Rhythm differs from repetition: "in the former the shapes change but it is still recognizable, whereas in the latter the shape remains constant". A university lecture gives a different definition, so the secondary sources disagree. — [Designing Buildings Wiki](https://www.designingbuildings.co.uk/wiki/Principles_of_Order_in_Architecture); contrast [TIU Lecture 6 Ordering Principles](https://lecture-notes.tiu.edu.iq/wp-content/uploads/2023/06/Lecture-6-Ordering-Principles.pdf)
- Symmetry: a figure "bisected by an axis is divided into two areas which are mirror images of one another." — [Designing Buildings Wiki](https://www.designingbuildings.co.uk/wiki/Principles_of_Order_in_Architecture)

**Proportion systems**
- Palladio's *Four Books* (1570), Book I, gives seven room shapes as "the most beautiful and well-proportioned": circular, square, and rectangles tied to the square's diagonal (√2) and to square-based ratios, commonly given as 1:1, √2:1, 4:3, 3:2, 5:3 and 2:1. — [Springer, Nexus Network Journal 2022](https://link.springer.com/article/10.1007/s00004-022-00592-1). The ratio list is the common reading; only the "seven shapes" framing was confirmed in the snippet.
- Serlio's seven rectangular ratios (Book I on Geometry, 1545) partly correspond to Palladio's seven room shapes. — [Politecnico di Torino paper, Nexus Netw J](https://iris.polito.it/bitstream/11583/2733947/3/NENJ-D-19-00004_R2.pdf) (snippet)
- Le Corbusier's Modulor "took the golden ratio and a man with a raised arm as the scalable modules of proportion". — [Wikipedia: Proportion (architecture)](https://en.wikipedia.org/wiki/Proportion_(architecture))
- Regulating lines (*tracés régulateurs*): an analysis of Villa Savoye's south elevation finds the main vertical proportions "loosely in a 3:4:5 proportion", with other elements placed by diagonals. Some elements, such as roof-level elements and mullions, are not generated by the lines, and Le Corbusier's application "appears to have been selective." — [UCLan student essay on Issuu, "Ideal Villa"](https://issuu.com/atehrani/docs/ideal_villa_2) (student work; snippet)
- The 1:2 (square : double square) ratio was the starting point for Le Corbusier's later Modulor work. Colin Rowe's "Mathematics of the Ideal Villa" compares Villa Stein/de Monzie (1927) with Palladio's Malcontenta. — [Issuu "Ideal Villa"](https://issuu.com/atehrani/docs/ideal_villa_2) (snippet)
- A US municipal code (Dallas-area ordinance) references the golden mean (1:1.618) and Fibonacci proportions for locating windows and doors, and requires a tripartite facade. — [ecode360 Ordinance 45146354](https://ecode360.com/45146354) (snippet)

**Base–middle–top and vertical rhythm (codes)**
- Tripartite division (base, shaft, capital) dates to late-19th-century Chicago skyscrapers. — [Chicago Architecture Center encyclopedia: Tripartite Division](https://architecture.org/online-resources/architecture-encyclopedia/tripartite-division)
- Iowa City: the base is set apart by string courses, cornice expression or awnings, and the top of a building of 3+ storeys gets a cornice treatment. **Buildings of two storeys or fewer do not need a middle section.** — [Iowa City code](https://codelibrary.amlegal.com/codes/iowacityia/latest/iowacity_ia/0-0-0-30946) (snippet)
- Palo Alto: buildings of 3+ storeys on lots wider than 50 ft must differentiate base, middle and top, and vertical modulation sets a rhythm. Storefront rhythm is roughly 30–50 ft wide. — [Palo Alto 18.24.060 Façade Design](https://codelibrary.amlegal.com/codes/paloalto/latest/paloalto_ca/0-0-0-85705) (snippet)
- Bellevue: a vertically articulated base, middle and top, expressed through material and scale, with vertical articulation of windows, columns and bays. — [Bellevue LUC 20.25A.180](https://bellevue.municipal.codes/LUC/20.25A.180) (snippet)
- Milwaukee multi-family guidance: a distinct base, middle and top creates a well-ordered facade. Windows should be set **at least 3 inches (about 75 mm) deep** into the wall so the facade does not look flat. — [Milwaukee Design Guidelines: Multi-Family Residential](https://city.milwaukee.gov/Designguidelines/UrbanDesignResources/UrbanDesignBuildingDevelopmentTypes/Multi-Family-Residential.htm) (snippet)

**Glazing, reveals, materials (UK)**
- The UK National Model Design Code says guidance may cover window design based on local character. Glazing "might be limited to 35%" outside city centres, where fully glazed facades may be allowed, and codes can direct window orientation and **the depth of reveals**. — [DLUHC Fact sheet 6: Sustainable design and placemaking](https://assets.publishing.service.gov.uk/media/6543b9941f1a600010360ce8/Fact_sheet_6._Sustainable_design_and_placemaking.pdf) (snippet; the search tool itself flagged this as needing checking against Part 2)
- NMDC Part 2 lists "local building vernacular, architecture, proportion, façade pattern and proportion" as code content. On materials it covers brick, stone or render for walls, slate or tile for roofs, and colours, textures, shapes and patterns. — [NMDC Part 2 Guidance Notes PDF](https://assets.publishing.service.gov.uk/media/6111531fd3bf7f043c4badd1/NMDC_Part_2_Guidance_Notes.pdf) (snippet)
- Minimalist facade practice uses a few materials (glass, raw concrete, render, metal). How they are handled matters more than which they are, with plane depths and opening orientation set so the facade changes through the day "with no extra material". — [Illustrarch: Minimalist facade design](https://illustrarch.com/facade-design/25246-minimalist-facade-design-in-architecture.html) (snippet)

**Daylight as a plan-and-facade generator**
- Alexander, *A Pattern Language* (1977), Pattern 159 "Light on Two Sides of Every Room": "This pattern, perhaps more than any other single pattern, determines the success or failure of a room." Two-sided light reduces glare around people and objects. "In a small building, it is easy to give every room light on two sides: one room in each of the four corners of a house does it automatically." Larger buildings need a more convoluted edge. If a room deeper than about 8 ft cannot have two-sided light, use a high ceiling, white walls and large high windows. — [patternlanguage.com APL 159](https://www.patternlanguage.com/apl/apl159/apl159.htm)

### Inferences
- Proportion rules worth encoding: room plan ratios inside the Palladian band (1:1 to 2:1, preferring 1:√2, 3:2, 5:3); window openings vertically proportioned; and a regulating datum (common head height and sill line per storey). These are cheap checks on `Room` rectangles and `openingsFor` output. Treat them as a soft score, not hard rules, since even Le Corbusier applied them selectively.
- For 1–2 storey houses, a full tripartite facade is not expected (Iowa City exempts ≤2 storeys). A **plinth/base band plus a strong roof/eave "top"** is enough, which `Scene.tsx` photo mode already partly draws (plinth and slab bands). For apartments of 3–10 storeys, add a differentiated ground floor, a repeated middle and a distinct top floor or parapet.
- Window reveal depth of at least 75 mm (Milwaukee) gives a concrete number for the 3D and drawings: windows should never sit flush with the outer wall face.
- Hierarchy: one element should dominate each elevation, such as the entrance, a double-height living space or the largest roof. This can be scored by checking that the largest volume or roof is significantly bigger than the others.
- Alexander 159 supports the existing "second window for cross-ventilation" logic and argues for L, U and courtyard plans and corner rooms over deep boxes.

### Gaps
- No authoritative numeric solid-to-void ratio for houses was found, apart from the NMDC 35% glazing example (unverified against the full text).
- No sourced rule on colour palettes, and none on roofscape composition (roof hierarchy, eaves depth) beyond general principles.
- The "2–3 materials" rule could not be verified. A search summary attributed "no more than three, or at most four, exterior materials per project" to a practitioner Substack (Sean D. Sweeney), but the page returned 404 and the attribution is uncertain. It is widely repeated in practice but unsourced here.
- Golden-section evidence: no empirical source was found showing that the public prefers golden-ratio facades over other ratios.

## 3. What makes houses look institutional, boxy, barracks-like or distasteful, and the moves that fix it

### Takeaway
Planning codes and preference research converge. Long, unbroken, flat, repetitive or blank elevations read as monotonous or institutional, and featureless or reflective surfaces lower affective ratings. The fixes codes prescribe are articulation (porches, bays, projections, recesses, wall-plane changes, dormers, recessed garages), deep window reveals, setback variation between neighbours, and material and detail variation. Codes also warn against over-complexity, consistent with research that preference peaks at moderate, ordered complexity.

### Cited Findings
- Merri-bek (Victoria, AU) Good Design advice sheet 2, *Exterior appearance*, flags "long facades lacking variety or physical breaks" as something to avoid. — [Merri-bek advice sheet PDF](https://www.merri-bek.vic.gov.au/globalassets/website-merri-bek/areas/building-business/planning-and-building/planning/the-good-design-advice-sheets---2.-exterior-appearance.pdf) (snippet; fetch blocked)
- Lakemoor (IL) code: street-facing elevations must be broken up with a porch, projections, bay windows, a recessed garage, or another architectural feature. — [Lakemoor code](https://codelibrary.amlegal.com/codes/lakemoor/latest/lakemoor_il/0-0-0-4606) (snippet)
- Ordinance No. 10702 (2021): long, uninterrupted facades should be articulated through recesses, bays, projections or wall-plane changes. — [ecode360 37227737](https://ecode360.com/37227737) (snippet)
- A related ecode360 ordinance says exterior walls should be articulated but "neither monotonous nor overly complex". — [ecode360 37227613](https://ecode360.com/37227613) (snippet; which of the two ecode360 pages carries this phrase was not verified)
- Monroe (NC): requires variation in architecture and elevations "to avoid uniform appearance", via modulation, porches or dormers. Its aim is to prevent developments where dwellings look identical or very similar. — [Monroe NC code](https://codelibrary.amlegal.com/codes/monroe/latest/monroe_nc/0-0-0-69085) (snippet)
- Sacramento County multifamily standards require a minimum **2 ft (about 0.6 m) setback variation** between adjacent buildings to avoid monotonous streetscapes. — [Sacramento County Design Guidelines ch.3](https://landuse.saccounty.gov/dg/ch3/) (snippet)
- Bensenville (IL): street-facing facades need articulation, such as entries, bay windows or porches, to avoid blank walls. — [Bensenville code](https://codelibrary.amlegal.com/codes/bensenvilleil/latest/bensenville_il/0-0-0-7815) (snippet)
- Milwaukee: windows set at least 3 in deep so the facade does not look flat. — [Milwaukee multi-family guidelines](https://city.milwaukee.gov/Designguidelines/UrbanDesignResources/UrbanDesignBuildingDevelopmentTypes/Multi-Family-Residential.htm) (snippet)
- Boulder publishes a "side yard wall articulation guide" for long side walls of houses. — [Boulder side yard wall articulation guide](https://bouldercolorado.gov/side-yard-wall-articulation-guide) (title only; content not read)
- Research: Brzezicki (2013) links "reflective, featureless or monotonous surfaces" with lower valence and arousal and with safety and clarity concerns. — reported in [Wang, Ding & Gath-Morad 2025, "A Systematic Review: Affective Perception on Urban Facade", arXiv 2509.22599](https://arxiv.org/html/2509.22599v1)
- Research: Ellard (2012) claims monotonous facades induce stress. The review notes this comes from a non-empirical source. — [arXiv 2509.22599](https://arxiv.org/html/2509.22599v1)
- Research: Calleri et al. (2017, 2018) found symmetrical, regular fenestration improves valence while keeping arousal balanced, so regularity in itself is not the problem. — [arXiv 2509.22599](https://arxiv.org/html/2509.22599v1)
- Research: White & Gatersleben (2011) found greenery on residential buildings is rated restorative and beautiful. — [arXiv 2509.22599](https://arxiv.org/html/2509.22599v1)
- Public preference: a UK commentary on visual preference surveys says the public consistently prefer "more traditionally conceived streets and buildings with detail, biomorphic forms, variety within a coherent pattern and more textured building materials." — [RIBA Journal: "When it comes to people's preferences about architecture, the numbers matter"](https://www.ribaj.com/intelligence/public-opinion-architecture-why-numbers-matter/) (snippet; page 403)
- A US national poll (commissioned by an advocacy body) reported Americans prefer traditional over modernist architecture for federal buildings "by a nearly three to one margin." — [CNU: Americans' Preferred Architecture for Federal Buildings](https://cnu.org/node/8029) (advocacy-linked; snippet)
- Material richness as an anti-institutional move: a hospital project chose a glazed terracotta rainscreen to depart from the usual institutional palette. — [Payette](https://payette.com/?p=48385) (snippet; attribution from search summary)

### Inferences
- An "institutional / barracks" detector for the engine could flag:
  - any elevation run longer than about 8–10 m with no plane change of at least 0.6 m. The 0.6 m comes from Sacramento's 2 ft; the 8–10 m length is an inference, not sourced.
  - identical windows at identical spacing along a whole elevation with no hierarchy element, such as an entrance, bay or larger opening.
  - windows flush with the wall (reveal under 75 mm).
  - a single uninterrupted roof over a long bar.
  - no porch, veranda or canopy marking the entrance.
- Fix moves already modelled in `Design.elements` (porch, veranda, balcony, canopy, pergola, screen, feature-wall, planter) are exactly the code-prescribed articulation devices. The engine should require at least one entrance element and one plane change per street elevation.
- "Variety within a coherent pattern" (RIBA J) and "neither monotonous nor overly complex" (code) both argue for a cap on articulation. Too many projections or materials is the opposite failure mode. See the inverted-U finding in section 4.
- Symmetric, regular fenestration is not itself institutional (Calleri). Monotony arises from scale (long runs), flatness and lack of hierarchy, not from regularity.
- Greenery or planters against facades (`landscape.ts`, `planter` elements) carry a measured positive valence effect.

### Gaps
- No academic source specifically defining the "institutional" or "barracks" look in housing was found. The detector thresholds above are inferences from codes.
- The long-corridor and double-loaded-corridor critique was not sourced. Alexander's patterns on short passages were not fetched.
- No sourced maximum number of materials or colours was found (see section 2 gaps).

## 4. Theory references and measurable aesthetic metrics (Vitruvius, Alexander, Ching, Venturi, Pallasmaa; complexity, symmetry, fractal measures, preference studies)

### Takeaway
Classic theory gives the vocabulary: firmness, commodity and delight; patterns; ordering principles; both-and; multisensory experience. Empirical work gives the targets. Facade complexity follows an **inverted-U**, with moderate, ordered complexity preferred. Symmetry and regular fenestration raise valence. Material texture and greenery help, and featureless or reflective surfaces hurt. Fractal dimension and visual attention are used as computable proxies, and traditional and postmodern facades score higher than plain modern ones.

### Cited Findings
**Theory**
- Vitruvius's triad in the Latin is *firmitas, utilitas, venustas*. Alberti and Palladio reversed the order of the first two, and Alberti replaced *venustas* with *amoenitas* ("pleasure"). — [Britannica: "Commodity, firmness, and delight": the ultimate synthesis](https://www.britannica.com/topic/architecture/Commodity-firmness-and-delight-the-ultimate-synthesis); [Khōrein Vol.3 No.1 (2025) "Contesting Beauty"](https://khorein.ifdt.bg.ac.rs/index.php/ch/article/view/73) (snippets)
- A 2025 *Khōrein* article argues it is uncertain whether *venustas* is a category in the same sense as *firmitas* and *utilitas*. — [Khōrein 2025](https://khorein.ifdt.bg.ac.rs/index.php/ch/article/view/73) (snippet)
- Pallasmaa, *The Eyes of the Skin* (1996): touch, not vision, is the basis of sensory experience ("the senses are specialisations of skin tissue"). The book critiques ocularcentrism. Sean Griffiths calls Pallasmaa's appeal to "unmediated sensual encounters" "highly problematic", while granting that architecture addressing sound, smell and touch is "perhaps, uncontroversial". — [UCL Press, *Architecture_MPS*](https://journals.uclpress.co.uk/amps/article/pubid/Archit_MPS-27-2/) (snippet)
- Alexander Pattern 159 (above). — [patternlanguage.com](https://www.patternlanguage.com/apl/apl159/apl159.htm)
- Ching's six ordering principles (above). — [Ching ch.7](https://archive.org/download/ArchitectureFormSpaceAndOrderCh7/Architecture_Form%20Space%20and%20Order_Ch7.pdf)
- Venturi both-and; hierarchy as the basis for layered meaning (above). — [Mount Holyoke blog](https://commons.mtholyoke.edu/architectualblog/?p=2)

**Empirical metrics and preference**
- A systematic review of 61 studies under PRISMA (Wang, Ding & Gath-Morad 2025) identifies **complexity, materiality, symmetry and biophilic integration** as consistent predictors of affective response (valence and arousal) to facades. It reports no effect sizes. — [arXiv 2509.22599](https://arxiv.org/html/2509.22599v1)
- Complexity follows an inverted-U, with moderate complexity most favoured (Imamoglu 2000; Akalin et al. 2009). Beyond a threshold, added skyline detail becomes a cognitive burden (Heath et al. 2000). Eye-tracking (Beder et al. 2024) shows *order within complexity*, not density, drives preference, and excess visual load lowers valence. — [arXiv 2509.22599](https://arxiv.org/html/2509.22599v1). Note: the review once calls this "U-shaped" but describes an inverted-U.
- Strong enclosure combined with medium entropy gives the highest restorative experience (Lindal & Hartig 2013). — [arXiv 2509.22599](https://arxiv.org/html/2509.22599v1)
- A study of 213 students argues for identifying physical attributes that give an "intermediate level of complexity". — [Hussein 2020, SASBE, doi:10.1108/SASBE-05-2019-0069](https://doi.org/10.1108/SASBE-05-2019-0069) (snippet)
- An Iranian discrete-choice study found that ornamentation, material contrast and curved geometries raise perceived complexity and positively influence preference. — via [MDPI Buildings 15(17):3161](https://mdpi.com/2075-5309/15/17/3161) (snippet; attribution from search summary)
- Lee & Ostwald (2023), "The 'visual attractiveness' of architectural facades", *Architectural Science Review* 66(1):42–52, measured visual complexity as fractal dimension D and attraction as visual-attention data across Modern, Postmodern and Neo-modern houses. Attractive strength was "higher for the Postmodern houses than for the other two types." The summary page gives no numeric values. — [Notre Dame Housing & Community Regeneration summary](https://housingandcommunityregeneration.nd.edu/research/the-visual-attractiveness-of-architectural-facades-measuring-visual-complexity-and-attractive-strength-in-architecture/)
- A Master's thesis (SLU 2023) reports that traditional architecture shows higher fractal dimensions, "a more intricate and complex topology characterized by detailed elements". — [SLU thesis, Cartajenas 2023](https://stud.epsilon.slu.se/19507/1/cartajenas-a-k-20230919.pdf) (snippet)
- Fractal preference in general: Taylor-lab work finds preference peaks at moderately low D for *statistical* fractals, such as natural scenes, Pollock and horizon lines. For *exact* fractals, preference rose with D (1.1–1.9; linear trend p<0.001, η²=0.38; about 76% of participants preferred higher D). Hagerhall et al. (2015) found higher alpha "waking restfulness" for statistical fractals at D = 1.1, 1.3 and 1.5. — [Bies, Blanc-Goldhammer, Boydston, Taylor & Sereno 2016, Front. Hum. Neurosci. 10:210 (PMC4873502)](https://pmc.ncbi.nlm.nih.gov/articles/PMC4873502)
- A review co-authored by Brielmann, Buras, Salingaros and Taylor links "the optimal range for the fractal dimension" to unconscious visual attraction. — search summary; exact URL not verified (possibly [MDPI Fractal Fract. 8(12):746](https://mdpi.com/2504-3110/8/12/746))
- Survey data: 76% of UK respondents believe building appearance affects mental health, and 75% report positive moods from appealing facades (Thinks Insight 2023, cited in the review). — [arXiv 2509.22599](https://arxiv.org/html/2509.22599v1)
- Related empirical work not read in full: "AffectCity: An Empirical Investigation of Complexity, Transparency, and Materiality in Shaping Affective Perception of Building Facades". — [arXiv 2604.18768](https://arxiv.org/pdf/2604.18768) (title only)

### Inferences
- A computable "facade score" for BuildWise could combine:
  - (a) a complexity term with an inverted-U penalty: count of plane changes, openings and elements per 10 m of elevation, rewarding the middle band.
  - (b) an order term: shared head and sill datums, consistent window module, symmetry about the entrance or main volume.
  - (c) material richness: 2–3 finishes with texture contrast, as in `BlockFinish` walls/base/accent.
  - (d) a biophilic term: planters, pergolas, trees near the facade.
  - (e) depth: reveals and projections generating shadow.

  Fractal dimension of a rendered elevation (box-counting on the `DrawingSet` SVG) is a published, computable proxy, but target D values for facades were not found.
- "Ordered complexity" is the key synthesis: symmetry or regularity plus detail beats either a blank box (too simple) or a scattered collage (disordered). This maps neatly onto `reviewDesign` scoring and the AI critique step's instructions.
- Vitruvius's triad can frame the engine's review into three scores: structure/feasibility (firmitas), plan function (utilitas, already covered by `checkDesign`) and delight (venustas, the facade score above).
- Pallasmaa suggests the concept story should mention touch, sound, shade and air (texture of materials, sound of rain on a veranda roof, breeze), not only views. This is useful prompt guidance for `ConceptCard` stories.

### Gaps
- No source gave numeric target ranges for facade fractal dimension or for elements per metre. The inverted-U is established, but its peak is not quantified for houses.
- Christopher Alexander's "quality without a name" (*The Timeless Way of Building*) and *The Nature of Order*'s 15 properties were not reached in this pass.
- No cross-cultural preference study specific to West African or Nigerian housing was found. Most preference studies are European, North American or Iranian, and generalisation to the BuildWise market is unverified.
- Effect sizes for symmetry and materiality were not reported in the systematic review.
