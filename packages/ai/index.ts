
import { createOpenAI } from '@ai-sdk/openai';
import OpenAI from 'openai';


const client = new OpenAI({
    apiKey: process.env['OPENAI_API_KEY'], // This is the default and can be omitted
});


const openai = createOpenAI({
    // custom settings, e.g.
    headers: {
        'header-name': 'header-value',
    },
});
