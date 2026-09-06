import { expect, test } from '@playwright/test';

test('two players can create, join, ready, and reach an active board', async ({ browser }) => {
  const playerOne = await browser.newPage();
  await playerOne.goto('/');
  await playerOne.getByRole('button', { name: 'Create new game' }).click();

  const roomCode = playerOne.getByText(/^[A-Z2-9]{8}$/);
  await expect(roomCode).toBeVisible();
  const roomId = (await roomCode.innerText()).trim();
  expect(roomId).toMatch(/^[A-Z2-9]{8}$/);

  const playerTwo = await browser.newPage();
  await playerTwo.goto(`/?room=${roomId}`);

  await expect(playerOne.getByRole('heading', { name: 'Both players connected' })).toBeVisible();
  await expect(playerTwo.getByRole('heading', { name: 'Both players connected' })).toBeVisible();

  await playerOne.getByRole('button', { name: 'Ready!' }).click();
  await playerTwo.getByRole('button', { name: 'Ready!' }).click();

  await expect(playerOne.getByRole('grid', { name: 'Tic-Tac-Toe board' })).toBeVisible();
  await expect(playerTwo.getByRole('grid', { name: 'Tic-Tac-Toe board' })).toBeVisible();
  await expect(playerOne.getByText('Your turn')).toBeVisible();

  await playerOne.getByRole('button', { name: /Row 1, column 1: empty/ }).click();
  await expect(playerOne.getByRole('button', { name: /Row 1, column 1: marked X/ })).toBeVisible();
  await expect(playerTwo.getByRole('button', { name: /Row 1, column 1: marked X/ })).toBeVisible();

  await playerOne.close();
  await playerTwo.close();
});
