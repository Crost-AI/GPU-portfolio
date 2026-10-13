'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { AlertCircle, Check, ImagePlus, Loader2, X } from 'lucide-react'
import { Section } from '@/components/settings/section'

export function FundNameSection({ name, logo, address, contactEmail, onSaved }: { name: string; logo: string | null; address: string | null; contactEmail: string | null; onSaved: () => void }) {
  const [value, setValue] = useState(name)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [logoPreview, setLogoPreview] = useState<string | null>(logo)
  const [logoSaving, setLogoSaving] = useState(false)
  const [logoError, setLogoError] = useState<string | null>(null)
  const [addressValue, setAddressValue] = useState(address ?? '')
  const [addressSaving, setAddressSaving] = useState(false)
  const [addressSaved, setAddressSaved] = useState(false)
  const [emailValue, setEmailValue] = useState(contactEmail ?? '')
  const [emailSaving, setEmailSaving] = useState(false)
  const [emailSaved, setEmailSaved] = useState(false)
  const [emailError, setEmailError] = useState<string | null>(null)

  const handleSave = async () => {
    setSaving(true)
    const res = await fetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fundName: value }),
    })
    setSaving(false)
    if (res.ok) {
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
      onSaved()
    }
  }

  const handleLogoFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setLogoError(null)

    if (file.size > 200 * 1024) {
      setLogoError('File must be under 200KB')
      e.target.value = ''
      return
    }

    const reader = new FileReader()
    reader.onload = async () => {
      const dataUrl = reader.result as string
      setLogoPreview(dataUrl)
      setLogoSaving(true)
      const res = await fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fundLogo: dataUrl }),
      })
      setLogoSaving(false)
      if (res.ok) {
        onSaved()
      } else {
        setLogoPreview(logo)
        setLogoError('Failed to upload logo')
      }
    }
    reader.readAsDataURL(file)
    e.target.value = ''
  }

  const handleRemoveLogo = async () => {
    setLogoSaving(true)
    setLogoError(null)
    const res = await fetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fundLogo: null }),
    })
    setLogoSaving(false)
    if (res.ok) {
      setLogoPreview(null)
      onSaved()
    }
  }

  return (
    <Section title="Fund name & logo">
      <div className="flex flex-col sm:flex-row items-stretch sm:items-end gap-3">
        <div className="flex-1">
          <Label>Name</Label>
          <Input value={value} onChange={(e) => setValue(e.target.value)} />
        </div>
        <Button onClick={handleSave} disabled={saving || value === name} size="sm">
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : saved ? <Check className="h-3.5 w-3.5" /> : 'Save'}
        </Button>
      </div>

      <div className="mt-4 pt-4 border-t">
        <Label>Logo</Label>
        <p className="text-xs text-muted-foreground mb-2">
          Upload a logo to display in the header. Max 200KB.
        </p>
        <div className="flex items-center gap-3">
          {logoPreview ? (
            <div className="relative">
              <img
                src={logoPreview}
                alt="Fund logo"
                className="h-12 w-12 rounded border object-contain bg-background"
              />
              <button
                onClick={handleRemoveLogo}
                disabled={logoSaving}
                className="absolute -top-1.5 -right-1.5 bg-destructive text-destructive-foreground rounded-full p-0.5 hover:bg-destructive/90 disabled:opacity-50"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ) : (
            <label className="flex items-center gap-2 cursor-pointer border rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-accent transition-colors">
              <ImagePlus className="h-4 w-4" />
              Choose file
              <input
                type="file"
                accept="image/*"
                onChange={handleLogoFile}
                className="hidden"
              />
            </label>
          )}
          {logoPreview && (
            <label className="flex items-center gap-2 cursor-pointer text-xs text-muted-foreground hover:text-foreground transition-colors">
              Replace
              <input
                type="file"
                accept="image/*"
                onChange={handleLogoFile}
                className="hidden"
              />
            </label>
          )}
          {logoSaving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        </div>
        {logoError && (
          <p className="text-sm text-destructive mt-1 flex items-center gap-1">
            <AlertCircle className="h-3 w-3" /> {logoError}
          </p>
        )}
      </div>

      <div className="mt-4 pt-4 border-t">
        <Label>Address</Label>
        <p className="text-xs text-muted-foreground mb-2">
          Displayed on LP documents (capital account statements, notices, letters, reports) below the fund name.
          A vehicle can replace the name, logo, address or email with its own letterhead, from Edit on the fund&rsquo;s Status page or Edit letterhead on a partner&rsquo;s capital statement.
        </p>
        <textarea
          value={addressValue}
          onChange={e => setAddressValue(e.target.value)}
          rows={3}
          className="w-full border rounded p-2 text-sm bg-background mb-2"
          placeholder="123 Main St&#10;New York, NY 10001"
        />
        <Button
          size="sm"
          disabled={addressSaving || addressValue === (address ?? '')}
          onClick={async () => {
            setAddressSaving(true)
            const res = await fetch('/api/settings', {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ fundAddress: addressValue || null }),
            })
            setAddressSaving(false)
            if (res.ok) {
              setAddressSaved(true)
              setTimeout(() => setAddressSaved(false), 2000)
              onSaved()
            }
          }}
        >
          {addressSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : addressSaved ? <Check className="h-3.5 w-3.5" /> : 'Save'}
        </Button>
      </div>

      <div className="mt-4 pt-4 border-t">
        <Label>Email</Label>
        <p className="text-xs text-muted-foreground mb-2">
          Printed under the address on the same documents.
        </p>
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
          <Input type="email" value={emailValue} onChange={e => setEmailValue(e.target.value)} placeholder="partners@fund.com" className="flex-1" />
          <Button
            size="sm"
            disabled={emailSaving || emailValue === (contactEmail ?? '')}
            onClick={async () => {
              setEmailSaving(true); setEmailError(null)
              const res = await fetch('/api/settings', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ fundContactEmail: emailValue || null }),
              })
              setEmailSaving(false)
              if (res.ok) {
                setEmailSaved(true)
                setTimeout(() => setEmailSaved(false), 2000)
                onSaved()
              } else {
                setEmailError((await res.json().catch(() => ({}))).error ?? 'Could not save email')
              }
            }}
          >
            {emailSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : emailSaved ? <Check className="h-3.5 w-3.5" /> : 'Save'}
          </Button>
        </div>
        {emailError && (
          <p className="text-sm text-destructive mt-1 flex items-center gap-1">
            <AlertCircle className="h-3 w-3" /> {emailError}
          </p>
        )}
      </div>
    </Section>
  )
}
