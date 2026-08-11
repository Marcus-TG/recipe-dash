import React from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { App } from './App'
import { CookConfirm } from './pages/CookConfirm'
import { CookMode } from './pages/CookMode'
import { Inbox } from './pages/Inbox'
import { ItemDetail } from './pages/ItemDetail'
import { Pantry } from './pages/Pantry'
import { ReceiptReview } from './pages/ReceiptReview'
import { RecipeDetail } from './pages/RecipeDetail'
import { Recipes } from './pages/Recipes'
import { Tonight } from './pages/Tonight'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        {/* Cook mode is full-screen: deliberately outside the nav chrome. */}
        <Route path="/recipes/:id/cook" element={<CookMode />} />
        <Route path="/cook/:sessionId/confirm" element={<CookConfirm />} />
        <Route element={<App />}>
          <Route path="/" element={<Tonight />} />
          <Route path="/pantry" element={<Pantry />} />
          <Route path="/pantry/:id" element={<ItemDetail />} />
          <Route path="/inbox" element={<Inbox />} />
          <Route path="/inbox/:id" element={<ReceiptReview />} />
          <Route path="/recipes" element={<Recipes />} />
          <Route path="/recipes/:id" element={<RecipeDetail />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
)
