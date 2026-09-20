# Measures DeskGhost's footprint: the deskghost.exe process plus all its WebView2 child processes.
# Usage: powershell -File tools\measure.ps1 [-Seconds 20]
param([int]$Seconds = 20)

$root = (Get-Process deskghost -ErrorAction Stop | Select-Object -First 1).Id
$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId
$ids = @($root); $added = $true
while ($added) {
  $added = $false
  foreach ($p in $all) { if ($ids -contains $p.ParentProcessId -and -not ($ids -contains $p.ProcessId)) { $ids += $p.ProcessId; $added = $true } }
}
$procs = $ids | ForEach-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue }

$cpu1 = ($procs | Measure-Object CPU -Sum).Sum
$gpuSamples = @()
$pidRe = ($ids | ForEach-Object { "pid_$($_)_" }) -join '|'
$end = (Get-Date).AddSeconds($Seconds)
while ((Get-Date) -lt $end) {
  $s = (Get-Counter '\GPU Engine(*)\Utilization Percentage' -ErrorAction SilentlyContinue).CounterSamples |
       Where-Object { $_.InstanceName -match $pidRe }
  $gpuSamples += ($s | Measure-Object CookedValue -Sum).Sum
}
$procs = $ids | ForEach-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue }
$cpu2 = ($procs | Measure-Object CPU -Sum).Sum
$gpuMem = ((Get-Counter '\GPU Process Memory(*)\Dedicated Usage' -ErrorAction SilentlyContinue).CounterSamples |
           Where-Object { $_.InstanceName -match $pidRe } | Measure-Object CookedValue -Sum).Sum

$cores = [Environment]::ProcessorCount
"Processes:        {0}" -f $procs.Count
"RAM (private):    {0:N0} MB" -f (($procs | Measure-Object PrivateMemorySize64 -Sum).Sum / 1MB)
"RAM (working set):{0:N0} MB" -f (($procs | Measure-Object WorkingSet64 -Sum).Sum / 1MB)
"CPU:              {0:N1}% of one core  ({1:N2}% of all {2} threads)" -f (($cpu2 - $cpu1) / $Seconds * 100), (($cpu2 - $cpu1) / $Seconds * 100 / $cores), $cores
"GPU (3D engine):  {0:N1}% average" -f (($gpuSamples | Measure-Object -Average).Average)
"GPU memory:       {0:N0} MB dedicated" -f ($gpuMem / 1MB)
