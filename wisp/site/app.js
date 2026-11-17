'use strict';
const command = document.getElementById('install-command');
const result = document.getElementById('copy-result');
const platforms = {
  linux: {
    command: 'curl -fL https://momonong.me/sites/wisp/install.sh -o /tmp/wisp-install.sh\nbash /tmp/wisp-install.sh',
    label: 'Linux 終端指令', download: 'install.sh',
    note: '需要 Python 3.10+。首次會準備官方依賴；完成後輸入 wisp，或使用 ~/.local/bin/wisp。',
    docs: 'https://hermes-agent.nousresearch.com/docs/getting-started/installation'
  },
  windows: {
    command: 'Invoke-WebRequest https://momonong.me/sites/wisp/install.ps1 -OutFile "$env:TEMP\\wisp-install.ps1"\npowershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\\wisp-install.ps1"',
    label: 'Windows PowerShell 指令', download: 'install.ps1',
    note: 'Windows 預覽版，實機驗收中。PowerShell 與 Git Bash 共用 wisp；Git Bash 安裝指令見使用說明。完成後重開終端。',
    docs: 'https://hermes-agent.nousresearch.com/docs/user-guide/windows-native'
  }
};
document.querySelectorAll('[data-platform]').forEach(button => {
  button.addEventListener('click', () => {
    const selected = platforms[button.dataset.platform];
    command.value = selected.command;
    document.getElementById('command-label').textContent = selected.label;
    document.getElementById('platform-note').textContent = selected.note;
    document.getElementById('download').href = selected.download;
    document.getElementById('engine-doc').href = selected.docs;
    document.querySelectorAll('[data-platform]').forEach(other => other.setAttribute('aria-pressed', String(other === button)));
    result.textContent = '';
  });
});
document.getElementById('copy-command').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(command.value);
    result.textContent = '已複製。貼到自己的終端執行即可。';
  } catch {
    command.focus(); command.select();
    result.textContent = '瀏覽器未允許自動複製，請複製已選取的指令。';
  }
});
