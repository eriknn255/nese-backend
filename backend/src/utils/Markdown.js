const MarkdownIt = require("markdown-it");
const sanitizeHtml = require("sanitize-html");

const md = new MarkdownIt({
    breaks: true,
    linkify: true
});

function sanitizarTexto(valor, tamanhoMaximo = 500) {
    if (typeof valor !== "string") return "";

    return valor
        .replace(/<[^>]*>/g, "")
        .replace(/[<>]/g, "")
        .trim()
        .slice(0, tamanhoMaximo);
}

function sanitizarDescricao(valor, tamanhoMaximo = 3000) {
    if (typeof valor !== "string") return "";

    const markdown = valor.trim().slice(0, tamanhoMaximo);

    return sanitizeHtml(md.render(markdown), {
        allowedTags: [
            "p", "br",
            "strong", "b",
            "em", "i",
            "ul", "ol", "li",
            "blockquote",
            "code", "pre",
            "a"
        ],
        allowedAttributes: {
            a: ["href", "target", "rel"]
        },
        allowedSchemes: ["http", "https", "mailto"]
    });
}

module.exports = {
    sanitizarTexto,
    sanitizarDescricao
};