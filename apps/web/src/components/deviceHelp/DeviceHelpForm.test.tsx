import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import DeviceHelpForm, { readHelpToken } from './DeviceHelpForm';

const TOKEN = 'A'.repeat(48);

function json(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  window.location.hash = `#${TOKEN}`;
  fetchMock = vi.fn(async (url: RequestInfo | URL) => {
    if (String(url).endsWith('/check')) return json({ valid: true });
    return json({ ticketNumber: 'T-2026-0042' }, 201);
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.location.hash = '';
});

async function fill() {
  // applyAccept off: prove the component's own type check, not the browser's file filter.
  const user = userEvent.setup({ applyAccept: false });
  await user.type(await screen.findByLabelText('Your name'), 'Asha Rao');
  await user.type(screen.getByLabelText('Phone number to call you on'), '+1 555 0100');
  await user.type(screen.getByLabelText('Company name'), 'Cubestack');
  await user.type(screen.getByLabelText('Email'), 'asha@example.com');
  await user.type(screen.getByLabelText('What is the problem?'), 'Outlook crashes');
  return user;
}

describe('DeviceHelpForm', () => {
  it('reads the token from the fragment', () => {
    expect(readHelpToken(`#${TOKEN}`)).toBe(TOKEN);
    expect(readHelpToken('')).toBe('');
  });

  it('without a token it says the link is not valid and calls nothing', async () => {
    window.location.hash = '';
    render(<DeviceHelpForm />);
    expect(await screen.findByTestId('device-help-invalid')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('checks the token in the body (not the URL) and shows the invalid message for a dead link', async () => {
    fetchMock.mockImplementation(async () => json({ valid: false }));
    render(<DeviceHelpForm />);
    expect(await screen.findByTestId('device-help-invalid')).toBeInTheDocument();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).not.toContain(TOKEN);
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ token: TOKEN });
    expect((init as RequestInit).credentials).toBe('omit');
  });

  it('sends every field plus the token as multipart without credentials, then shows the reference', async () => {
    render(<DeviceHelpForm />);
    const user = await fill();
    await user.click(screen.getByTestId('device-help-submit'));
    expect(await screen.findByTestId('device-help-sent')).toHaveTextContent('T-2026-0042');
    const [url, init] = fetchMock.mock.calls[1]!;
    expect(String(url)).toMatch(/\/api\/v1\/device-help\/public\/submit$/);
    expect((init as RequestInit).credentials).toBe('omit');
    const body = (init as RequestInit).body as FormData;
    expect(body.get('token')).toBe(TOKEN);
    expect(body.get('name')).toBe('Asha Rao');
    expect(body.get('company')).toBe('Cubestack');
    expect(body.has('screenshot')).toBe(false);
  });

  it('refuses a non-image screenshot before sending', async () => {
    render(<DeviceHelpForm />);
    const user = await fill();
    const input = screen.getByLabelText('Screenshot of the error (optional)');
    await user.upload(input, new File(['%PDF-1.4'], 'doc.pdf', { type: 'application/pdf' }));
    expect(await screen.findByText('Choose a PNG, JPEG or WebP image.')).toBeInTheDocument();
    expect(screen.getByTestId('device-help-submit')).toBeDisabled();
  });

  it('stays on the form when the server refuses', async () => {
    fetchMock.mockImplementation(async (url: RequestInfo | URL) =>
      String(url).endsWith('/check') ? json({ valid: true }) : json({ error: 'Too many requests' }, 429));
    render(<DeviceHelpForm />);
    const user = await fill();
    await user.click(screen.getByTestId('device-help-submit'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId('device-help-sent')).not.toBeInTheDocument();
    expect(screen.getByTestId('device-help-submit')).toBeEnabled();
  });
});
