import { expect, test } from '@playwright/test';
import { PHONES, expectAccessible, signIn } from './helpers';

test.describe.configure({ timeout: 180_000 });

test('the welcome screen asks what to build and offers the marketplace to shoppers', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: /What would you like to build today/ })).toBeVisible();
  for (const name of ['Bungalow', 'Block of flats', 'Office building', 'Hotel', 'School', 'Church or mosque']) await expect(page.getByRole('link', { name })).toBeVisible();
  await expectAccessible(page, 'welcome');
  await page.getByRole('link', { name: /Just shopping/ }).click();
  await expect(page).toHaveURL(/\/market$/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Everything your build needs');
});

/** From the taste step: design it, then choose the first concept, landing on the design. */
async function openSavedDesign(page: import('@playwright/test').Page) {
  const go = page.getByRole('button', { name: 'Design it for me' });
  await expect(go).toBeVisible();
  if (!(await go.isEnabled())) await page.getByRole('button', { name: 'Choose for me' }).click();
  await go.click();
  await expect(page.getByRole('heading', { level: 1, name: 'Choose your design' })).toBeVisible({ timeout: 60_000 });
  // The concept the person is choosing: its name follows the design everywhere.
  const chosen = await page.locator('.concept-option.selected h2').textContent();
  await page.getByRole('button', { name: 'Choose this design' }).click();
  await expect(page.getByRole('navigation', { name: 'Your design' })).toBeVisible({ timeout: 60_000 });
  return chosen!.trim();
}

test('pick a building, give the plot, and a saved build shows 3D, notes, cost, materials and where to buy', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Bungalow' }).click();
  await page.getByRole('button', { name: 'My family' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Where will it stand?' })).toBeVisible({ timeout: 90_000 });
  await page.getByRole('button', { name: '50 × 100 ft (full plot)' }).click();
  await expect(page.getByRole('img', { name: /3D model of a 15.24 m by 30.48 m plot/ })).toBeVisible({ timeout: 60_000 });
  await page.getByLabel(/Town or city/).fill('Ibadan');
  await page.getByRole('button', { name: 'Next: make it yours' }).click();

  await expect(page.getByRole('heading', { level: 1, name: 'What should it feel like?' })).toBeVisible();
  await page.getByText('Add details', { exact: true }).click();
  await expect(page.getByRole('group', { name: 'Bedrooms' }).locator('output')).toHaveText('3');
  await page.getByRole('button', { name: 'More: bedrooms' }).click();
  await expect(page.getByRole('group', { name: 'Bedrooms' }).locator('output')).toHaveText('4');
  await page.getByRole('button', { name: 'Gym' }).click();
  await expect(page.getByRole('button', { name: 'Gym' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText(/Review several concept options before choosing your design/)).toBeVisible();
  await expectAccessible(page, 'build: make it yours');

  const chosen = await openSavedDesign(page);
  // The design is presented under the name it was chosen by, with its numbers, notes and checks.
  await expect(page.getByRole('heading', { level: 1, name: chosen, exact: true })).toBeVisible();
  await expect(page.getByText(/Bungalow · Ibadan · concept design/)).toBeVisible();
  await expect(page.getByText(/Architect.s checklist/)).toBeVisible();
  await expect(page.locator('.check-row.fail')).toHaveCount(0);
  await page.getByRole('button', { name: 'Ground floor plan' }).click();
  await expect(page.locator('.scene-room').first()).toBeAttached();
  await page.locator('summary', { hasText: 'Rooms' }).click();
  await expect(page.getByRole('cell', { name: 'Gym', exact: true })).toBeVisible();
  await expectAccessible(page, 'build: your design');

  const tabs = page.getByRole('navigation', { name: 'Your design' });
  await tabs.getByRole('button', { name: 'Cost' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Budget and cost plan' })).toBeVisible();
  await tabs.getByRole('button', { name: 'Materials' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Everything you need to build it' })).toBeVisible();
  await expect(page.getByRole('row', { name: /Cement \(50 kg bags\)/ })).toContainText(/\d+ bag/);
  await expect(page.getByRole('row', { name: /Sandcrete blocks, 9 inch/ })).toContainText(/piece/);
  await expectAccessible(page, 'build: materials');
  await page.getByRole('button', { name: 'Find where to buy' }).click();
  await expect(page.getByRole('heading', { level: 1, name: /Where to buy/ })).toBeVisible();
  await expect(page.getByText(/for the [1-9]\d* of \d+ items with a matching price/)).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.offer').first()).toBeVisible();
  await expectAccessible(page, 'build: where to buy');
});

test('a commercial building from one sentence: a four-storey hotel with a lift, drawn floor by floor', async ({ page }) => {
  await page.goto(`/build?q=${encodeURIComponent('A 4-storey hotel with 40 rooms on a 100 by 120 ft plot')}`);
  await expect(page.getByRole('heading', { level: 1, name: 'What should it feel like?' })).toBeVisible({ timeout: 90_000 });
  await page.getByText('Add details', { exact: true }).click();
  await expect(page.getByRole('group', { name: 'Storeys' }).locator('output')).toHaveText('4 (G+3)');
  await expect(page.getByRole('group', { name: 'Guest rooms per floor' }).locator('output')).toHaveText('10');
  await expect(page.getByRole('button', { name: 'Restaurant' })).toHaveAttribute('aria-pressed', 'true');
  const hotel = await openSavedDesign(page);
  expect(hotel).toMatch(/^Hotel: /);
  await expect(page.getByRole('heading', { level: 1, name: hotel, exact: true })).toBeVisible();
  await expect(page.getByText(/Four-storey hotel with \d+ guest rooms/).first()).toBeVisible();
  await expect(page.locator('.check-row.fail')).toHaveCount(0);
  await page.getByRole('button', { name: 'Third floor' }).click();
  await expect(page.locator('.scene-room').first()).toBeAttached();
  await page.locator('summary', { hasText: 'Rooms' }).click();
  await expect(page.getByRole('cell', { name: 'Lift', exact: true }).first()).toBeVisible();
  await expectAccessible(page, 'build: hotel');

  await page.getByRole('link', { name: /Concept drawings/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: /Concept drawings/ })).toBeVisible();
  for (const name of [/A-101 Ground floor plan/, /A-104 Third floor plan/, /A-201 Elevations/]) await expect(page.getByRole('img', { name })).toBeVisible();
});

test('a house design comes with ready-made plans from the marketplace and printable concept drawings', async ({ page }) => {
  await page.goto(`/build?q=${encodeURIComponent('A 3 bedroom bungalow on a 60 by 120 ft plot with boys quarters')}`);
  await expect(page.getByRole('heading', { level: 1, name: 'What should it feel like?' })).toBeVisible({ timeout: 90_000 });
  await page.getByText('Add details', { exact: true }).click();
  await page.getByText('More about the rooms').click();
  await expect(page.getByLabel(/Boys' quarters/)).toBeChecked();
  await openSavedDesign(page);
  await expect(page.getByText(/Architect.s notes/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Other directions' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Ready-made plans from architects that fit your plot' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('link', { name: /3-bedroom bungalow plan/ })).toBeVisible();
  await expectAccessible(page, 'build: design with plans');

  await page.getByRole('link', { name: /Concept drawings/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: /Concept drawings/ })).toBeVisible();
  for (const name of [/A-100 Site plan/, /A-101 Ground floor plan/, /A-201 Elevations/, /A-301 Section/]) await expect(page.getByRole('img', { name })).toBeVisible();
  await expect(page.getByRole('button', { name: /Print or save as PDF/ })).toBeVisible();
  await expectAccessible(page, 'build: drawings');
});

test('the person adjusts the design, picks a roof and landscapes the plot', async ({ page }) => {
  await page.goto(`/build?q=${encodeURIComponent('A 3 bedroom bungalow on a 50 by 100 ft plot')}`);
  await expect(page.getByRole('heading', { level: 1, name: 'What should it feel like?' })).toBeVisible({ timeout: 90_000 });
  await openSavedDesign(page);
  await page.getByRole('navigation', { name: 'Your design' }).getByRole('button', { name: 'Adjust rooms' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Adjust your home' })).toBeVisible();
  await expect(page.getByText(/^As designed/)).toBeVisible();

  // Select the living room from the plan with the keyboard and divide it in two; a wall move that breaks a minimum
  // size is refused with a reason and changes nothing.
  await page.getByRole('button', { name: /^Living/ }).first().focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 2, name: /^Living/ })).toBeVisible();
  await page.getByRole('button', { name: 'Divide in two' }).click();
  await expect(page.getByText(/^1 change/)).toBeVisible();
  await page.getByRole('button', { name: /move in 0.3 m \(smaller room\)/ }).first().click({ clickCount: 1 });
  await page.getByLabel('Name').fill('Sitting room');
  await page.getByRole('button', { name: 'Rename' }).click();
  await expect(page.getByText(/^\d+ changes/)).toBeVisible();
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByText(/^\d+ changes?/)).toBeVisible();
  await expect(page.getByText(/Checklist after your changes/)).toBeVisible();

  // A concealed parapet roof with stone-coated tiles.
  await page.getByRole('radio', { name: /Concealed \(parapet\)/ }).check({ force: true });
  await expect(page.getByLabel(/Pitch:.*kept below the parapet/)).toBeVisible();
  await page.getByLabel('Covering').selectOption('stone-coated');
  await expectAccessible(page, 'build: adjust');

  await page.getByRole('button', { name: 'Plan the outdoors' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Landscape your plot' })).toBeVisible();
  await page.getByLabel('Swimming pool').check();
  await page.getByRole('radio', { name: /Place tree/ }).check({ force: true });
  await expectAccessible(page, 'build: outdoors');

  await page.getByRole('navigation', { name: 'Your design' }).getByRole('button', { name: 'Materials' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Everything you need to build it' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Landscaping and external works' })).toBeVisible();
  await expect(page.getByRole('row', { name: /Fence blocks, 9 inch sandcrete/ })).toBeVisible();
  await expect(page.getByRole('row', { name: /Stone-coated steel roof tiles/ })).toBeVisible();
  await expect(page.getByRole('row', { name: /Box gutter/ })).toBeVisible();
});

test('the Design Studio edits the building in 2D and 3D and takes it back to the build', async ({ page }) => {
  await page.goto(`/build?q=${encodeURIComponent('A 3 bedroom bungalow on a 50 by 100 ft plot')}`);
  await expect(page.getByRole('heading', { level: 1, name: 'What should it feel like?' })).toBeVisible({ timeout: 90_000 });
  await openSavedDesign(page);
  await page.getByRole('link', { name: 'Open in Design Studio' }).click();
  const plan = page.getByRole('group', { name: /^Plan of floor 0/ });
  await expect(plan).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('link', { name: /Architect\? Sign in to sell/ })).toBeVisible();
  // Place a pergola from the catalogue, then change its material.
  await page.getByRole('tab', { name: 'Outdoors' }).click();
  await page.getByRole('button', { name: 'Pergola' }).click();
  await plan.click({ position: { x: 60, y: 60 } });
  await expect(page.getByRole('heading', { level: 2, name: 'Pergola' })).toBeVisible();
  await page.getByLabel('Material').selectOption('metal-dark');
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByLabel('Material')).toHaveValue('timber');
  await expectAccessible(page, 'studio');
  await page.getByRole('button', { name: '3D', exact: true }).click();
  const model = page.getByRole('img', { name: /3D model of a 15.24 m by 30.48 m plot/ });
  await expect(model).toHaveAccessibleName(/Furnished ground floor/, { timeout: 60_000 });
  await page.getByRole('button', { name: 'Exterior', exact: true }).click();
  await expect(model).not.toHaveAccessibleName(/Furnished ground floor/);
  await page.getByRole('button', { name: 'Furnished floor', exact: true }).click();
  await expect(model).toHaveAccessibleName(/Furnished ground floor/);
  await page.getByRole('button', { name: 'Back to my build' }).click();
  await expect(page.getByRole('navigation', { name: 'Your design' })).toBeVisible({ timeout: 60_000 });
});

test('a certified architect gets "Publish design" in the Design Studio', async ({ page }) => {
  await signIn(page, PHONES.architect, '/studio');
  await expect(page.getByRole('group', { name: /^Plan of floor 0/ })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('button', { name: 'Publish design' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('link', { name: /Architect\? Sign in to sell/ })).toHaveCount(0);
});

test('systems with optional solar, the cost plan and the project record', async ({ page }) => {
  await page.goto('/build?type=bungalow');
  // The type is picked from the link; the one purpose question still comes first.
  await page.getByRole('button', { name: 'My family' }).click({ timeout: 90_000 });
  await expect(page.getByRole('heading', { level: 1, name: 'Where will it stand?' })).toBeVisible({ timeout: 90_000 });
  await page.getByRole('button', { name: '50 × 100 ft (full plot)' }).click();
  await page.getByLabel(/Town or city/).fill('Ibadan');
  await page.getByLabel(/^State/).fill('Oyo');
  await page.getByLabel(/^Country/).fill('Nigeria');
  await page.getByRole('button', { name: 'Next: make it yours' }).click();
  await page.getByText('Add details', { exact: true }).click();
  await page.getByLabel(/^Budget/).fill('30000000');
  await openSavedDesign(page);

  // Systems: solar is optional and off until chosen.
  const tabs = page.getByRole('navigation', { name: 'Your design' });
  await tabs.getByRole('button', { name: 'Cooling, water, power' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Cooling, water and power' })).toBeVisible();
  await expect(page.getByRole('cell', { name: /BTU/ }).first()).toBeVisible();
  await page.getByRole('tab', { name: /Power and solar/ }).click();
  await expect(page.getByText(/kVA generator/)).toBeVisible();
  await expect(page.getByText(/kWp/)).toHaveCount(0);
  await page.getByLabel('Plan for solar power with a battery').check();
  await expect(page.getByText(/kWp/).first()).toBeVisible();
  await expect(page.getByText(/usable battery/)).toBeVisible();
  await page.getByRole('button', { name: 'Confirm these systems' }).click();
  await expectAccessible(page, 'build: systems');

  await page.getByRole('button', { name: 'Plan the budget' }).click();
  await expect(page.getByText(/Estimated total/)).toBeVisible();
  await expect(page.getByRole('row', { name: /Solar power/ })).toBeVisible();
  await expectAccessible(page, 'build: budget');

  await tabs.getByRole('button', { name: 'Project record' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Your project record' })).toBeVisible();
  await expect(page.getByRole('row', { name: /Location.*Ibadan, Oyo, Nigeria/ })).toBeVisible();
  await expect(page.getByText(/solar: .*kWp solar/).first()).toBeVisible();
  // The person chose the layout on the reveal, so it is a confirmed decision, not one waiting for them.
  await expect(page.getByRole('region', { name: 'Decisions' }).getByText(/^layout$/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Waiting for you' })).toHaveCount(0);
  await expect(page.getByRole('cell', { name: 'Qualified solar installer' })).toBeVisible();
  await expectAccessible(page, 'build: project record');
});

test('entering the land size by hand draws the plot to scale', async ({ page }) => {
  await page.goto('/build');
  await page.evaluate(() => localStorage.removeItem('bw-build-v1'));
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'What are you building?' })).toBeVisible({ timeout: 60_000 });
  await expectAccessible(page, 'build: what');
  await page.getByRole('tab', { name: 'Commercial' }).click();
  await page.getByRole('button', { name: /^Office building/ }).click();
  await page.getByRole('button', { name: 'My own business' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Where will it stand?' })).toBeVisible();
  await page.getByText('Metres', { exact: true }).click();
  await page.getByLabel('Width (frontage), m').fill('20');
  await page.getByLabel('Depth, m').fill('40');
  await expect(page.getByRole('img', { name: /3D model of a 20 m by 40 m plot/ })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('status').filter({ hasText: '800 m²' })).toBeVisible();
  await page.getByRole('button', { name: 'Next: make it yours' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'What should it feel like?' })).toBeVisible();
  await page.getByText('Add details', { exact: true }).click();
  await expect(page.getByRole('group', { name: 'Storeys' }).locator('output')).toHaveText('4 (G+3)');
});

test('the assistant answers building questions and declines anything else', async ({ page }) => {
  await page.goto('/build');
  await page.evaluate(() => localStorage.removeItem('bw-build-v1'));
  await page.reload();
  await page.getByText('Have a question? Ask the Builder AI').click();
  const box = page.getByLabel('Message Builder AI');
  await box.fill('How many blocks can one bag of cement make?');
  await box.press('Enter');
  await expect(page.locator('.bubble.assistant').last()).toContainText('moulds', { timeout: 30_000 });
  await page.getByRole('button', { name: 'Helpful', exact: true }).last().click();
  await expect(page.getByRole('button', { name: 'Helpful', exact: true }).last()).toHaveAttribute('aria-pressed', 'true');
  await box.fill('tell me a joke');
  await box.press('Enter');
  await expect(page.locator('.bubble.assistant').last()).toContainText('only help with building');
});

test('staff can see what the assistant is learning', async ({ page }) => {
  await signIn(page, PHONES.ops, '/moderation/assistant');
  await expect(page.getByRole('heading', { level: 1, name: 'BuildWise assistant' })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('Held-out test accuracy')).toBeVisible();
  await expectAccessible(page, 'staff: assistant');
});

test('the plot stays empty until Design it for me, then three distinct concepts to compare and choose, consistent in the drawings', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/build');
  await page.getByRole('button', { name: /^Bungalow/ }).click();
  await page.getByRole('button', { name: 'My family' }).click();
  await page.getByRole('button', { name: '50 × 100 ft (full plot)' }).click();
  await page.getByLabel(/Town or city/).fill('Ibadan');
  // Before generation the only project visual is the plot: no building, no example render, no plan.
  const onlyPlot = page.getByRole('img', { name: '3D model of a 15.24 m by 30.48 m plot.', exact: true });
  await expect(onlyPlot).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Next: make it yours' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'What should it feel like?' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Design it for me' })).toBeDisabled();
  await page.getByRole('button', { name: /Tropical & open/ }).click();
  await page.getByRole('button', { name: 'Bigger garden', exact: true }).click();
  await expect(onlyPlot).toBeVisible();
  await expect(page.locator('.gal-plan')).toHaveCount(0);
  const recap = page.getByRole('region', { name: 'Your choices' });
  await expect(recap).toContainText('Tropical & open');
  await expect(recap).toContainText('Bigger garden');
  await expectAccessible(page, 'build: taste');

  await page.getByRole('button', { name: 'Design it for me' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Choose your design' })).toBeVisible({ timeout: 60_000 });
  // The taste survives into generation: the brief is drawn in its style.
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('bw-build-v1')!));
  expect(saved.project.preferences).toMatchObject({ purpose: 'family', taste: 'tropical', priorities: ['garden'] });
  expect(saved.brief.style).toBe('tropical');
  // Three checked concepts, each with its own name, reason and plan.
  const cards = page.getByRole('list', { name: 'Concept designs' }).locator(':scope > li');
  await expect(cards).toHaveCount(3);
  const titles = await page.locator('.concept-option h2').allTextContents();
  const tags = await page.locator('.concept-tag').allTextContents();
  expect(new Set(titles).size).toBe(3);
  expect(new Set(tags).size).toBe(3);
  await expect(page.locator('.concept-option .gal-plan')).toHaveCount(3);
  await expectAccessible(page, 'build: choose your design');

  await page.getByRole('button', { name: 'Compare designs' }).click();
  for (const row of ['Footprint', 'Halls, landings and stairs', 'Room relationships', 'Open ground', 'Indicative cost']) await expect(page.getByRole('rowheader', { name: row })).toBeVisible();
  await page.getByRole('button', { name: `Select ${titles[1]}` }).click();
  await expect(page.getByRole('button', { name: 'Selected' })).toHaveCount(1);
  await page.getByRole('button', { name: 'Choose this design' }).click();
  await expect(page.getByRole('navigation', { name: 'Your design' })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('heading', { name: 'How your choices shaped it' })).toBeVisible();
  // One name everywhere: the concept chosen on the reveal heads the design page and the drawings.
  await expect(page.getByRole('heading', { level: 1, name: titles[1], exact: true })).toBeVisible();
  await expect(page.getByText(/You chose Tropical & open/)).toBeVisible();
  for (const view of ['From the street', 'From the garden', 'At dusk']) await expect(page.getByRole('group', { name: 'View of your design' }).getByRole('button', { name: view })).toBeVisible();
  const area = (await page.locator('.stat-tiles').getByText(/ m²$/).first().textContent())!.replace(/[^\d]/g, '');

  // The drawings are drawn from the same design: the same floor area on the title block.
  await page.goto('/build/drawings');
  await expect(page.getByText(new RegExp(`${area}(\\.\\d)? m²`)).first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('heading', { level: 1, name: `Concept drawings: ${titles[1]}` })).toBeVisible();
});
