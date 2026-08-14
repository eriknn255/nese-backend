const db = require("../db");

// ==========================================================================
// ENVIO DE PUSH (FCM) — o outro lado da notificação in-app.
//
// Tudo aqui é MELHOR-ESFORÇO, mesmo princípio de criarNotificacao(): push é
// extra, e uma falha de rede com o Firebase não pode derrubar a publicação de
// uma avaliação que já aconteceu.
//
// A inicialização é preguiçosa e tolerante: sem GOOGLE_APPLICATION_CREDENTIALS
// (ou sem o pacote firebase-admin instalado) o módulo carrega normalmente e
// enviarPush() vira no-op. Isso mantém o servidor de desenvolvimento rodando
// sem credencial nenhuma, que é o caso comum de quem só mexe em outra parte.
// ==========================================================================

let messaging = null;
let jaTentouIniciar = false;

function obterMessaging() {
    if (jaTentouIniciar) return messaging;
    jaTentouIniciar = true;

    if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
        console.warn("[push] GOOGLE_APPLICATION_CREDENTIALS não definido — push desligado.");
        return null;
    }

    try {
        const admin = require("firebase-admin");
        if (!admin.apps.length) admin.initializeApp();
        messaging = admin.messaging();
    } catch (erro) {
        console.warn("[push] firebase-admin indisponível — push desligado:", erro.message);
        messaging = null;
    }
    return messaging;
}

/**
 * Manda o aviso pra todos os aparelhos da conta.
 *
 * DATA-ONLY de propósito, sem o bloco `notification`. Uma mensagem com
 * `notification` é montada e publicada pelo PRÓPRIO FCM quando o app está em
 * segundo plano — o código do app nem roda. Isso quebraria duas coisas: o
 * interruptor de "Notificações push" das preferências (que vive no aparelho e
 * o servidor não conhece) e a atualização do contador do sino. Com data-only,
 * o app sempre recebe e sempre decide.
 */
function enviarPush({ usuarioId, titulo, corpo = null, link = null }) {
    if (!usuarioId || !titulo) return;

    const fcm = obterMessaging();
    if (!fcm) return;

    const tokens = db
        .prepare("SELECT token FROM dispositivos WHERE usuario_id = ?")
        .all(usuarioId)
        .map((linha) => linha.token);

    if (tokens.length === 0) return; // conta sem aparelho registrado

    fcm.sendEachForMulticast({
        tokens,
        // Os três campos que o ServicoMensagens do app lê de `data`.
        data: {
            titulo: String(titulo),
            corpo: corpo == null ? "" : String(corpo),
            link: link == null ? "" : String(link),
        },
        // "high" é o que faz a mensagem furar o Doze. Sem isso, um aparelho
        // parado na mesa pode segurar o aviso por horas — que é exatamente o
        // problema que o push existe pra resolver.
        android: { priority: "high" },
    })
        .then((resultado) => {
            // Token morto (app desinstalado, dados limpos) responde
            // UNREGISTERED. Apagar na hora evita a tabela virar depósito de
            // lixo e o envio ficar mais lento a cada mês.
            resultado.responses.forEach((resposta, i) => {
                const codigo = resposta.error && resposta.error.code;
                if (
                    codigo === "messaging/registration-token-not-registered" ||
                    codigo === "messaging/invalid-registration-token"
                ) {
                    db.prepare("DELETE FROM dispositivos WHERE token = ?").run(tokens[i]);
                }
            });
        })
        .catch((erro) => {
            console.error("[push] Falha ao enviar:", erro.message);
        });
}

module.exports = { enviarPush };
