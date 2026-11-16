import type { KnowledgeDoc, TrainingExample } from './assistant';

/**
 * Seed data for the BuildWise assistant. SEED_EXAMPLES train the intent model; SEED_TESTS are held out and every
 * retrained model must still classify them correctly before it replaces the current one (so platform data can
 * improve the model but never quietly break it). SEED_KNOWLEDGE starts the knowledge base; staff answers and facts
 * from the platform's own data are added to it over time.
 */

const ex = (intent: TrainingExample['intent'], ...texts: string[]): TrainingExample[] => texts.map((text) => ({ text, intent }));

export const SEED_EXAMPLES: TrainingExample[] = [
  ...ex('build_home',
    'I want to build a 3 bedroom bungalow', 'build me a four bedroom duplex', 'a 2 bedroom flat on my land', 'I have a plot of 50 by 100 feet',
    'design a house for me', 'I want to build my house', 'help me design a home with 3 bedrooms', 'a self contain on half plot',
    'five bedroom duplex with boys quarters', 'two storey building with four bedrooms', 'a modern bungalow with open plan kitchen',
    'i want a house with a study and 2 parking spaces', 'my land is 60 by 120 ft', 'my plot is 15 by 30 metres', 'building a family home',
    'three bed with ensuite', 'i want to build a duplex', 'small house for a young family', 'a home with a flat roof', 'make it two storeys',
    'add a study', 'change it to 4 bedrooms', 'i want an open plan kitchen', 'hip roof please', 'start a new home design', 'mini flat design',
    'retirement bungalow with two bedrooms', 'house plan for my land', 'i want to see designs for my plot', 'storey building on a full plot',
    'i need a 3 bedroom detached house', 'design something tropical with a veranda', 'classic style house 4 bedrooms', 'a bungalow please',
    'let us build a home', 'i would like to build a four bedroom house', 'design a semi detached house', 'what can i build on my land'),
  ...ex('shopping',
    'where can i buy cement', 'price of blocks', 'i need 500 bags of cement', 'buy roofing sheets', 'who sells granite near me',
    'cheapest sharp sand', 'i want to order 9 inch blocks', 'where to get reinforcement bars', 'iron rods 12mm price', 'sell me tiles',
    'looking for a tipper of sand', 'where can i get long span aluminium roofing', 'i want to buy paint', 'show me cement sellers',
    'find a supplier of blocks', 'just shopping for materials', 'buy plumbing materials', 'i need a mason', 'hire an excavator',
    'find an electrician near me', 'where do i buy doors and windows', 'compare cement prices', 'order binding wire', 'buy pvc ceiling'),
  ...ex('other_project',
    'i want to build a fence', 'fencing my land', 'build a shop', 'construct a warehouse', 'build a church', 'school building project',
    'renovate my kitchen', 'add an extension to my house', 'drill a borehole', 'build a swimming pool', 'build a hostel', 'office block construction',
    'repair my roof', 'build a gatehouse', 'construct a perimeter wall', 'build a filling station', 'interlock my compound'),
  ...ex('question',
    'how many blocks can one bag of cement mould', 'what is the difference between 6 inch and 9 inch blocks', 'how much does it cost to build a house',
    'what is a setback', 'how deep should my foundation be', 'what mix ratio for concrete', 'do i need a building permit', 'what is a c of o',
    'how long does it take to build a bungalow', 'what is site coverage', 'how many bags of cement for a 3 bedroom', 'what roof is best',
    'how much is a bag of cement', 'what is a survey plan', 'how thick should a slab be', 'when should i cure concrete', 'what is a dpc',
    'how many rods for a bungalow', 'what does a quantity surveyor do', 'is long span better than stone coated', 'how many trips of sand do i need',
    'what is hardcore filling', 'how do i check my land documents', 'what is brc mesh', 'how big should a bedroom be', 'why do i need an architect',
    'what is the cost of roofing', 'how many tiles for a room', 'how do i calculate blocks', 'what is lintel', 'how is the materials list worked out',
    'are these designs approved', 'can i build without an engineer', 'what is a ring beam', 'how high should a window be',
    'do i need approval to build', 'do i need a survey plan', 'should i use long span roofing', 'is it ok to build in the rainy season',
    'can i use 6 inch blocks for outside walls', 'how much sand for plastering'),
  ...ex('greeting', 'hi', 'hello', 'good morning', 'hey there', 'good evening', 'hello buildwise', 'hi there how are you', 'good afternoon', 'howdy', 'yo'),
  ...ex('thanks', 'thanks', 'thank you', 'thank you so much', 'great thanks', 'ok thanks', 'nice one', 'perfect thank you', 'cheers', 'that helps thanks'),
  ...ex('out_of_scope',
    'tell me a joke', 'who won the football match', 'what is the weather today', 'write me a poem', 'what is the capital of france',
    'help me with my homework', 'recommend a movie', 'how do i cook rice', 'what is bitcoin price', 'who is the president', 'play some music',
    'translate this to french', 'what is the meaning of life', 'book me a flight', 'how do i lose weight', 'tell me about politics',
    'can you write code', 'what time is it', 'give me relationship advice', 'how to make money fast', 'who is messi',
    'what is quantum physics', 'price of a phone', 'when does the bank open', 'best phone to buy'),
];

export const SEED_TESTS: TrainingExample[] = [
  ...ex('build_home', 'i want a 4 bedroom bungalow', 'design my duplex', 'my plot is 50 by 100', 'three bedroom house with a study', 'build a two storey home'),
  ...ex('shopping', 'where can i buy blocks', 'cement price near me', 'i need roofing sheets', 'buy granite', 'find a plumber'),
  ...ex('other_project', 'build a fence around my land', 'construct a shop', 'renovate my bathroom', 'drill a borehole for water'),
  ...ex('question', 'how many blocks per bag of cement', 'what is the concrete mix ratio', 'do i need a permit to build', 'how deep is a foundation', 'what is a ring beam'),
  ...ex('greeting', 'hello there', 'good morning buildwise', 'hi'),
  ...ex('thanks', 'thank you very much', 'thanks a lot'),
  ...ex('out_of_scope', 'tell me a story', 'what is the football score', 'write a song for me', 'who is the best singer'),
];

const k = (id: string, question: string, answer: string, tags: string[]): KnowledgeDoc => ({ id, question, answer, tags, source: 'seed' });

/** General guidance, worded as typical practice. Exact requirements come from the local building code and professionals. */
export const SEED_KNOWLEDGE: KnowledgeDoc[] = [
  k('blocks-per-bag', 'How many blocks can one bag of cement mould?', 'A 50 kg bag of cement typically moulds 30 to 40 sandcrete blocks of 9 inches, or 40 to 50 of 6 inches, depending on the mix. Good blocks use about 1 part cement to 6 to 8 parts sharp sand and are cured for at least 7 days.', ['blocks', 'cement', 'bag', 'mould', 'sandcrete']),
  k('block-sizes', 'What is the difference between 6 inch and 9 inch blocks?', '9 inch (225 mm) blocks are used for outside walls, foundations and load-bearing walls. 6 inch (150 mm) blocks are used for inside partition walls. Both are 450 mm long and 225 mm high, so about 10 blocks make one square metre of wall.', ['blocks', '6 inch', '9 inch', 'wall', 'thickness']),
  k('calc-blocks', 'How do I calculate the number of blocks?', 'Take the wall area (length times height) and subtract doors and windows. Multiply by about 9.9 blocks per square metre, then add 5% for breakage. The materials list in the build flow does this for every wall of your design.', ['blocks', 'calculate', 'count', 'wall', 'area']),
  k('concrete-mix', 'What mix ratio should I use for concrete?', 'A common site mix for foundations, columns, beams and slabs is 1:2:4 (cement : sharp sand : granite). Block-laying mortar is usually 1:6 and plaster 1:4. Your structural engineer may specify a stronger mix for some parts.', ['concrete', 'mix', 'ratio', 'cement', 'sand', 'granite', 'mortar']),
  k('foundation-depth', 'How deep should my foundation be?', 'Strip foundations for a bungalow on firm soil are commonly 0.9 to 1.2 m deep, with a concrete strip about 675 mm wide and 225 mm thick. Soft, clay or waterlogged soil needs deeper or different foundations, so get a soil test and a structural engineer for your site.', ['foundation', 'depth', 'deep', 'strip', 'soil']),
  k('slab-thickness', 'How thick should a floor slab be?', 'A ground floor slab is usually 100 to 150 mm of concrete over compacted filling and a damp-proof membrane, often with BRC mesh. Suspended (upstairs) slabs are commonly 150 mm with steel designed by an engineer.', ['slab', 'thickness', 'thick', 'floor', 'concrete']),
  k('curing', 'How should I cure concrete and blocks?', 'Keep concrete wet for at least 7 days after casting (spray it or cover it with wet sacks), and keep it out of direct sun. Blocks should also be wetted and stacked in shade for 7 days or more before use.', ['cure', 'curing', 'concrete', 'blocks', 'water']),
  k('dpc', 'What is a DPC or DPM?', 'A damp-proof course (DPC) is a barrier laid in the wall just above ground level, and a damp-proof membrane (DPM) is a polythene sheet under the ground floor slab. Both stop moisture rising into the walls and floor.', ['dpc', 'dpm', 'damp', 'membrane', 'moisture']),
  k('hardcore', 'What is hardcore or laterite filling?', 'It is the compacted fill (usually laterite or broken stone) placed inside the foundation walls to raise the floor level before the slab. It is laid in layers and compacted, typically 300 mm or more deep.', ['hardcore', 'laterite', 'filling', 'fill', 'compaction']),
  k('brc', 'What is BRC mesh?', 'BRC mesh is a welded steel fabric (for example A142) laid in the ground floor slab to control cracking. It is ordered by area with about 10% extra for overlaps.', ['brc', 'mesh', 'slab', 'steel', 'reinforcement']),
  k('ring-beam', 'What is a ring beam?', 'A ring beam is a reinforced concrete band cast on top of the walls, usually 225 by 225 mm with four 12 mm bars and 8 mm links. It ties the walls together and carries the roof.', ['ring beam', 'beam', 'lintel', 'concrete', 'rods']),
  k('lintel', 'What is a lintel?', 'A lintel is a short reinforced concrete beam over a door or window opening that carries the blockwork above it. It should extend at least 150 mm onto the wall on each side.', ['lintel', 'door', 'window', 'beam', 'opening']),
  k('rods', 'How many iron rods do I need for a bungalow?', 'It depends on the design. For columns, ring beams and lintels, a typical three-bedroom bungalow uses a few dozen 12 mm bars and a similar number of 8 mm bars; a two-storey house needs several times more for its slab and beams. The materials list counts them for your design.', ['rods', 'iron', 'reinforcement', 'bars', '12mm', 'steel']),
  k('sand-trips', 'How much sand do I need?', 'Sand is used in concrete, block-laying mortar and plaster. A typical bungalow needs tens of tonnes of sharp sand and a smaller amount of plaster sand. The materials list gives tonnes for your design; one large tipper trip is usually about 20 to 30 tonnes.', ['sand', 'trips', 'tonnes', 'sharp sand', 'plaster sand', 'tipper']),
  k('material-prices', 'How much is a bag of cement or other materials?', 'Prices change often and differ by area. The marketplace shows live prices from sellers near you, and once enough sellers list an item I can quote the typical price here.', ['cement', 'blocks', 'sand', 'granite', 'rods', 'roofing', 'price', 'cost', 'bag']),
  k('cement-bungalow', 'How many bags of cement for a 3 bedroom bungalow?', 'Usually a few hundred 50 kg bags for foundations, slab, blockwork, plaster and beams, depending on size and finishes. The materials step works it out for your chosen design and shows how.', ['cement', 'bags', 'bungalow', '3 bedroom', 'how many']),
  k('cost-build', 'How much does it cost to build a house?', 'It depends on size, finishes and local prices. The build flow lists every material for your design and prices each line from live listings, so you can see a materials total for your plot. Add labour, transport and professional fees, which often add a significant share on top of materials.', ['cost', 'price', 'budget', 'house', 'build']),
  k('roof-types', 'Which roof is best?', 'Hip roofs (sloped on all four sides) handle wind well and are common for bungalows. Gable roofs (two slopes) are simpler and cheaper. Flat roofs with a parapet suit modern designs but need good waterproofing and a concrete slab.', ['roof', 'hip', 'gable', 'flat', 'parapet', 'best']),
  k('roof-sheets', 'Long span aluminium or stone coated roofing?', 'Long-span aluminium sheets are lighter and usually cheaper; 0.55 mm is a common thickness. Stone-coated steel tiles look like traditional tiles, are quieter in rain and last long, but cost more and need closer battens.', ['roofing', 'long span', 'aluminium', 'stone coated', 'sheets']),
  k('tiles', 'How many tiles do I need for a room?', 'Measure the floor area in square metres and add about 10% for cutting and breakage. Tiles are sold by the square metre or by carton, and each carton states how many square metres it covers.', ['tiles', 'floor', 'room', 'carton', 'square metre']),
  k('setback', 'What is a setback?', 'A setback is the space you must leave between your building and the plot boundary: at the front (facing the road), the sides and the rear. It keeps room for access, light, air and services. The dashed line on the 3D plot shows the setbacks used for your designs.', ['setback', 'boundary', 'building line', 'front', 'side']),
  k('coverage', 'What is site coverage?', 'Site coverage is the share of your plot covered by the building. Planning rules limit it so there is open space for light, air and drainage. Each design shows its coverage against the limit.', ['coverage', 'site', 'plot', 'percentage', 'planning']),
  k('room-size', 'How big should a bedroom be?', 'As a guide, a main bedroom of about 11 m² or more with a least width of 3 m, and other bedrooms of 8 m² or more with a least width of about 2.7 m. Each room also needs windows of at least about a tenth of its floor area for light and air.', ['bedroom', 'size', 'room', 'minimum', 'area']),
  k('window-height', 'How high should windows be?', 'Window sills are commonly about 0.9 m above the floor in living rooms and bedrooms, and higher (about 1.5 m) in bathrooms and toilets for privacy. Window heads usually line up with door heads at about 2.1 m.', ['window', 'height', 'sill', 'high']),
  k('permit', 'Do I need a building permit?', 'Yes. Before you build you normally need approved drawings and a building permit from the state planning authority. They will ask for architectural and structural drawings by registered professionals, your title documents and a survey plan.', ['permit', 'approval', 'planning', 'building plan', 'authority']),
  k('c-of-o', 'What is a C of O?', 'A Certificate of Occupancy (C of O) is a government document confirming a right to occupy and use the land. Check the title documents of any land carefully with a lawyer and at the land registry before you buy or build.', ['c of o', 'certificate', 'occupancy', 'land', 'title', 'documents']),
  k('survey-plan', 'What is a survey plan?', 'A survey plan is a document prepared by a registered surveyor showing the exact boundaries, size and location of your land with beacon numbers. You need it for land documents and building approval.', ['survey', 'plan', 'surveyor', 'beacons', 'land']),
  k('land-check', 'How do I check land documents?', 'Ask for the title documents and survey plan, then verify them at the land registry and with the state surveyor; use a property lawyer. Visit the land, check the beacons, and confirm there are no government acquisitions or disputes.', ['land', 'documents', 'verify', 'check', 'title', 'registry']),
  k('time-bungalow', 'How long does it take to build a bungalow?', 'With steady funding, a typical bungalow takes roughly 4 to 8 months from foundation to finishing; weather, approvals and cash flow often extend it.', ['time', 'how long', 'duration', 'bungalow', 'months']),
  k('architect', 'Why do I need an architect?', 'The designs here are concept designs. A registered architect turns your chosen concept into detailed, stamped drawings for approval, and checks local rules. A structural engineer designs the foundations, columns, beams and slabs.', ['architect', 'engineer', 'drawings', 'approval', 'professional']),
  k('designs-approved', 'Are these designs approved?', 'No. They are concept designs checked against common planning and building rules, to help you choose and estimate. You still need stamped drawings from registered professionals and approval from the planning authority before building.', ['designs', 'approved', 'concept', 'stamped', 'approval']),
  k('engineer', 'Can I build without an engineer?', 'It is not advisable. A structural engineer sizes the foundations, columns, beams and slabs for your soil and design, and approvals usually require structural drawings. Mistakes here are expensive and unsafe.', ['engineer', 'structural', 'without', 'safety']),
  k('qs', 'What does a quantity surveyor do?', 'A quantity surveyor measures quantities from the drawings, prices them, and manages costs during construction. BuildWise projects can get a professionally reviewed estimate from a quantity surveyor.', ['quantity surveyor', 'qs', 'estimate', 'cost', 'boq']),
  k('materials-method', 'How is the materials list worked out?', 'From the 3D design itself: wall lengths and heights minus doors and windows give the blocks; foundation, slab, beam and column sizes give the concrete, which is split into cement, sand and granite by the mix ratio; and so on. Every line shows its working. Allow for waste and confirm with a quantity surveyor before bulk orders.', ['materials', 'list', 'calculate', 'quantities', 'how']),
  k('self-contain', 'What is a self contain or mini flat?', 'A self-contain is one room with its own bathroom and kitchen area; a mini flat is a one-bedroom flat with a separate living room. Both are small homes you can design here by choosing one bedroom.', ['self contain', 'mini flat', 'one bedroom', 'small']),
  k('bq', 'What is a boys quarters (BQ)?', 'A BQ is a small separate building, usually at the back of the plot, with one or two rooms and a bathroom for staff or guests. It counts towards site coverage.', ['bq', 'boys quarters', 'outbuilding', 'staff']),
];
