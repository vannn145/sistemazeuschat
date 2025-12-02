'use strict';

const form = document.getElementById('loginForm');
const errorBox = document.getElementById('loginError');

async function attemptLogin(event) {
    event.preventDefault();
    if (errorBox) {
        errorBox.hidden = true;
    }

    const formData = new FormData(form);
    const payload = {
        username: formData.get('username'),
        password: formData.get('password')
    };

    try {
        const response = await fetch('/admin/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify(payload)
        });
        if (!response.ok) {
            throw new Error('Unauthorized');
        }
        window.location.href = '/admin';
    } catch (err) {
        if (errorBox) {
            errorBox.hidden = false;
            errorBox.textContent = 'Usuário ou senha inválidos.';
        }
    }
}

form?.addEventListener('submit', attemptLogin);
