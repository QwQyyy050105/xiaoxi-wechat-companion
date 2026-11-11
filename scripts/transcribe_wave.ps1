param([Parameter(Mandatory=$true)][string]$Language)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$audio = New-Object System.IO.MemoryStream
$engine = $null
try {
    Add-Type -AssemblyName System.Speech
    $recognizer = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() |
        Where-Object { $_.Culture.Name -eq $Language } | Select-Object -First 1
    if (-not $recognizer) { exit 3 }
    [Console]::OpenStandardInput().CopyTo($audio)
    $audio.Position = 0
    $engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine($recognizer)
    $engine.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
    $engine.SetInputToWaveStream($audio)
    $words = New-Object 'System.Collections.Generic.List[string]'
    $confidence = 1.0
    while ($true) {
        try { $phrase = $engine.Recognize() }
        catch [System.InvalidOperationException] {
            # Desktop SAPI can close an exhausted WAV instead of returning null.
            if ($audio.Position -eq $audio.Length) { break }
            throw
        }
        if ($null -eq $phrase) { break }
        if ($phrase.Text) {
            $words.Add($phrase.Text)
            $confidence = [Math]::Min($confidence, $phrase.Confidence)
        }
    }
    if ($words.Count -eq 0) { exit 4 }
    $result = @{text=($words -join ' '); confidence=$confidence}
    [Console]::WriteLine(($result | ConvertTo-Json -Compress))
} catch { exit 1 } finally {
    if ($engine) { $engine.Dispose() }
    $audio.Dispose()
}
