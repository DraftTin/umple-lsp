-- Umple LSP configuration for Neovim
-- Add this to your init.lua or source it with dofile()

-- ============================================================================
-- CONFIGURATION - Update these paths for your system
-- ============================================================================

local UMPLE_LSP_PATH = "/path/to/umple-lsp"  -- Change this!

-- ============================================================================
-- 1. Register .ump filetype
-- ============================================================================

vim.filetype.add({
  extension = {
    ump = "umple",
  },
})

-- ============================================================================
-- 2. Set up the LSP server
-- ============================================================================

local lspconfig = require("lspconfig")
local configs = require("lspconfig.configs")

-- Define Umple LSP (only if not already defined)
if not configs.umple then
  configs.umple = {
    default_config = {
      cmd = {
        "node",
        UMPLE_LSP_PATH .. "/server/out/server.js",
        "--stdio",
      },
      filetypes = { "umple" },
      -- Use file's directory or .git root (prevents scanning huge parent directories)
      root_dir = function(fname)
        local util = require("lspconfig.util")
        return util.root_pattern(".git")(fname) or vim.fn.fnamemodify(fname, ":h")
      end,
      single_file_support = true,
      init_options = {
        umpleSyncJarPath = UMPLE_LSP_PATH .. "/umplesync.jar",
        umpleSyncPort = 5555,
      },
    },
  }
end

lspconfig.umple.setup({
  on_attach = function(client, bufnr)
    local opts = { buffer = bufnr, noremap = true, silent = true }

    -- Go to definition
    vim.keymap.set("n", "gd", vim.lsp.buf.definition, opts)

    -- Show hover documentation (not implemented yet, but ready for future)
    -- vim.keymap.set("n", "K", vim.lsp.buf.hover, opts)

    -- Show references (not implemented yet, but ready for future)
    -- vim.keymap.set("n", "gr", vim.lsp.buf.references, opts)

    -- Show diagnostics in floating window
    vim.keymap.set("n", "<leader>e", vim.diagnostic.open_float, opts)

    -- Go to next/previous diagnostic
    vim.keymap.set("n", "[d", vim.diagnostic.goto_prev, opts)
    vim.keymap.set("n", "]d", vim.diagnostic.goto_next, opts)
  end,
})

-- ============================================================================
-- 3. Register the tree-sitter parser (for syntax highlighting)
-- ============================================================================

local ok, parser_config = pcall(function()
  return require("nvim-treesitter.parsers").get_parser_configs()
end)

if ok then
  parser_config.umple = {
    install_info = {
      url = UMPLE_LSP_PATH .. "/tree-sitter-umple",
      files = { "src/parser.c" },
    },
    filetype = "umple",
  }
end

-- ============================================================================
-- 4. Optional: Configure diagnostics display
-- ============================================================================

vim.diagnostic.config({
  virtual_text = true,      -- Show diagnostics as virtual text
  signs = true,             -- Show signs in the sign column
  underline = true,         -- Underline diagnostic text
  update_in_insert = false, -- Don't update diagnostics in insert mode
  severity_sort = true,     -- Sort by severity
})

-- Custom diagnostic signs
local signs = { Error = " ", Warn = " ", Hint = " ", Info = " " }
for type, icon in pairs(signs) do
  local hl = "DiagnosticSign" .. type
  vim.fn.sign_define(hl, { text = icon, texthl = hl, numhl = hl })
end

-- ============================================================================
-- Usage:
-- 1. Update UMPLE_LSP_PATH at the top of this file
-- 2. Add to your init.lua:
--    dofile('/path/to/umple-lsp/editors/neovim/umple.lua')
-- 3. Run :TSInstall umple (after restarting Neovim)
-- 4. Symlink queries:
--    ln -s /path/to/umple-lsp/tree-sitter-umple/queries ~/.local/share/nvim/queries/umple
-- ============================================================================
