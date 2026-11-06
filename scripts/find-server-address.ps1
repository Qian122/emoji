$addresses = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object {
        $_.IPAddress -notlike '127.*' -and
        $_.IPAddress -notlike '169.254.*' -and
        $_.InterfaceOperationalStatus -eq 'Up'
    } |
    Select-Object InterfaceAlias, IPAddress

if (-not $addresses) {
    Write-Host '未找到可用的局域网 IPv4 地址。'
    exit 1
}

$addresses | Format-Table -AutoSize
Write-Host ''
Write-Host '在安卓真机中填写：http://上表中的IPv4地址:3000'
