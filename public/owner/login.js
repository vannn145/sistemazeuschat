const form = document.getElementById('login-form');
const errorBox = document.getElementById('login-error');

const ownerBasePath = (() => {
    const segments = window.location.pathname.split('/').filter(Boolean);
    if (!segments.length || segments[0] !== 'owner') {
        return '/owner';
    }
    const tenant = segments[1];
    if (!tenant || tenant === 'login' || tenant === 'assets') {
        return '/owner';
    }
    return `/owner/${tenant}`;
})();

const ownerApiBase = `${ownerBasePath}/api`;
const tenantKey = (() => {
    const parts = ownerBasePath.split('/').filter(Boolean);
    if (parts.length === 1) {
        return 'default';
    }
    return parts[1] || 'default';
})();

const copyByTenant = {
    default: {
        badge: 'CD Center',
        title: 'Painel da Diretoria',
        hint: 'Use as credenciais compartilhadas com a diretoria do CD Center.',
        footnote: 'Suporte: atendimento@cdcenter.com.br',
        sideTitle: 'Operação CD Center',
        sideText: 'Visualize confirmações, pendências e disparos em tempo real.',
        suggestUser: 'dir'
    },
    haertel: {
        badge: 'Haertel Radiologia',
        title: 'Painel Haertel',
        hint: 'Acesso exclusivo da diretoria Haertel. Utilize o usuário dedicado informado pela equipe.',
        footnote: 'Suporte Haertel: suporte@haertel.com.br',
        sideTitle: 'Visão Estratégica Haertel',
        sideText: 'Acompanhe confirmações, mensagens e indicadores da operação Haertel.',
        suggestUser: 'haertel'
    }
};

const copy = copyByTenant[tenantKey] || copyByTenant.default;

document.body.dataset.tenant = tenantKey;

const badgeEl = document.getElementById('tenant-badge');
const titleEl = document.getElementById('login-title');
const hintEl = document.getElementById('login-hint');
const footnoteEl = document.getElementById('login-footnote');
const sideTitleEl = document.getElementById('side-title');
const sideTextEl = document.getElementById('side-text');
const usernameInput = document.getElementById('username');

if (badgeEl) badgeEl.textContent = copy.badge;
if (titleEl) titleEl.textContent = copy.title;
if (hintEl) hintEl.textContent = copy.hint;
if (footnoteEl) footnoteEl.textContent = copy.footnote;
if (sideTitleEl) sideTitleEl.textContent = copy.sideTitle;
if (sideTextEl) sideTextEl.textContent = copy.sideText;
if (usernameInput && copy.suggestUser) {
    usernameInput.placeholder = copy.suggestUser;
}

if (form) {
    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        errorBox.hidden = true;
        errorBox.textContent = '';

        const formData = new FormData(form);
        const payload = {
            username: formData.get('username')?.trim() || '',
            password: formData.get('password') || ''
        };

        try {
            const response = await fetch(`${ownerApiBase}/login`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            });

            const data = await response.json();
            if (!response.ok || !data.success) {
                const message = data?.message || 'Não foi possível entrar. Verifique usuário e senha.';
                errorBox.textContent = message;
                errorBox.hidden = false;
                return;
            }

            window.location.href = data?.redirect || ownerBasePath;
        } catch (error) {
            errorBox.textContent = error?.message || 'Erro inesperado ao autenticar.';
            errorBox.hidden = false;
        }
    });
}
