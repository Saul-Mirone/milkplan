import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// Testing Library keeps rendered trees mounted between tests unless told
// otherwise, and a leftover App would keep its fetch promise alive.
afterEach(cleanup)
