import assert from 'node:assert/strict';

export default {
  name: 'bot-avatar-crop',
  entry: './bot-avatar-crop-fixture.tsx',
  viewport: { width: 720, height: 640 },
  real: 'BotPortraitPicker upload entry, account AvatarCropEditor, real image decode, crop geometry and export',
  notCovered:
    'Native chooser and HDR conversion are host substitutes; full app persistence, remote transport and Mobile are not covered',
  cases: {
    default: { about: 'Upload, drag/zoom, confirm, cancel, repeat selection and invalid image' },
  },
  async check(page, ui) {
    const initial = await page.getByTestId('avatar-result').textContent();
    const dataUrl = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 800;
      canvas.height = 400;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#1a6b46';
      ctx.fillRect(0, 0, 400, 400);
      ctx.fillStyle = '#da9b36';
      ctx.fillRect(400, 0, 400, 400);
      return canvas.toDataURL();
    });
    const file = {
      name: 'wide.png',
      mimeType: 'image/png',
      buffer: Buffer.from(dataUrl.split(',')[1], 'base64'),
    };
    const upload = async (image = file) => {
      await page.evaluate(
        (source) => {
          window.__botAvatarUpload = source;
        },
        `data:${image.mimeType};base64,${image.buffer.toString('base64')}`,
      );
      await page
        .getByRole('button', { name: await ui.t('bots.profile.changeAvatar'), exact: true })
        .click();
      await page
        .getByRole('button', { name: await ui.t('bots.guided.upload'), exact: true })
        .click();
    };
    await upload();
    const stage = page.getByRole('group', {
      name: await ui.t('settings.userProfile.edit.crop.stageLabel'),
    });
    await stage.waitFor();
    await page
      .getByRole('button', {
        name: await ui.t('settings.userProfile.edit.crop.zoomIn'),
        exact: true,
      })
      .click();
    const box = await stage.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 45, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
    assert.equal(await page.getByTestId('avatar-result').textContent(), initial);
    await ui.capture('crop');
    await page
      .getByRole('button', { name: await ui.t('settings.userProfile.edit.crop.done'), exact: true })
      .click();
    await page.getByRole('alertdialog').waitFor({ state: 'hidden' });
    const result = await page.getByTestId('avatar-result').textContent();
    assert.notEqual(result, initial);
    assert.notEqual(result, dataUrl);
    const pixels = await page.evaluate(async (src) => {
      const image = new Image();
      image.src = src;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0);
      const row = context.getImageData(0, Math.floor(canvas.height / 2), canvas.width, 1).data;
      let green = 0;
      for (let x = 0; x < canvas.width; x++) if (row[x * 4 + 1] > row[x * 4]) green++;
      return { width: canvas.width, height: canvas.height, greenFraction: green / canvas.width };
    }, result);
    assert.equal(pixels.width, pixels.height);
    assert.ok(pixels.width > 0 && pixels.width < 400);
    // At a centered crop the split is 50%. A 45px rightward image drag must
    // move the split right by 45 / viewport diameter in the exported pixels.
    const diameter = Math.min(240, box.width - 48, box.height - 48);
    assert.ok(
      Math.abs(pixels.greenFraction - (0.5 + 45 / diameter)) < 0.04,
      `Drag did not reach exported pixels: green fraction ${pixels.greenFraction}`,
    );
    await ui.capture('confirmed');
    await upload();
    await stage.waitFor();
    await page
      .getByRole('button', { name: await ui.t('settings.userProfile.edit.cancel'), exact: true })
      .click();
    assert.equal(await page.getByTestId('avatar-result').textContent(), result);
    await upload({
      name: 'broken.png',
      mimeType: 'image/png',
      buffer: Buffer.from('invalid image'),
    });
    await page.getByRole('alert').waitFor();
    assert.equal(await page.getByRole('alertdialog').count(), 0);
    assert.equal(await page.getByTestId('avatar-result').textContent(), result);
  },
};
