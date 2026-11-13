// A real Lead Intake Assessment run (live trial, 2026-11-13): the website excerpts sent to the model and
// the model's raw response, saved verbatim. Replaying them offline checks the validators against what a
// model actually produced. The website stores its phone number as a Markdown telephone link.
export const REPLAY_SOURCES: { id: string; sourceUrl: string; text: string }[] = [
  {
    "id": "S3",
    "sourceUrl": "https://www.sadowski-hvac.com/",
    "text": "## Tell us what you need\n\nShare the property location and a short description. We’ll contact you to discuss the work and scheduling.\n\nName(Required)\n\nEmail(Required)\n\nPhone(Required)\n\nChoose Service\n\nResidential HVACCommercial HVACOther\n\nResidential HVAC\n\n- Residential HVAC\n- Commercial HVAC\n- Other\n\nComments\n\nName\n\nThis field is for validation purposes and should be left unchanged.\n\nSubmitting a request does not book an appointment. We’ll confirm availability with you.\n\n**Based in Linden** Heating and cooling for homes & businesses\n\n**NJ contractor registration** Home Improvement Contractor #13VH11514600\n\n**★★★★★ 5.0 on Google** [Read our customer reviews](https://goo.gl/maps/yfcAxxwKgKQ3dNeu7)\n\nHomes and businesses"
  },
  {
    "id": "S4",
    "sourceUrl": "https://www.sadowski-hvac.com/emergency-hvac-repair-in-linden-nj/",
    "text": "## Emergency HVAC repair across heating, cooling, and controls.\n\nUrgent HVAC problems do not always stay neatly inside one category. A thermostat issue can look like equipment failure. An airflow issue can freeze an AC coil. A safety switch can shut down heat. We look at the full operating chain.\n\n- 1 Central air conditioning systems with no cooling, frozen coils, or outdoor unit failure.\n- 2 Furnaces with ignition failure, blower problems, overheating, or lockout behavior.\n- 3 Heat pumps with heating or cooling loss, defrost issues, aux heat concerns, or reversing valve symptoms.\n- 4 Boilers with no heat, pressure problems, circulator failure, leaks, or control faults.\n- 5 Mini split and ductless systems with error codes, poor output, leaks, or indoor head problems.\n- 6 Thermostats, zoning, condensate safeties, wiring, and electrical components that stop normal operation.\n\n![Emergency HVAC electrical and control diagnostics in Linden NJ](https://www.sadowski-hvac.com/wp-content/uploads/2026/04/emergency-hvac-controls-diagnostics-linden-nj.jpg)\n\nEmergency Repair Process"
  },
  {
    "id": "S7",
    "sourceUrl": "https://www.sadowski-hvac.com/",
    "text": "## Questions about HVAC service in Linden\n\nHave a question about your equipment? [Contact our team](https://www.sadowski-hvac.com/contact-us/) with a few details.\n\nHow do I arrange a service visit?\n\nCall [732-551-7848](tel:+17325517848) or use the request form with your property address and a short description. We will confirm service availability and discuss scheduling. Office hours are Monday–Friday, 8:00 AM–5:00 PM.\n\nCan I request help without knowing the equipment model?\n\nYes. Describe the problem and whether the equipment serves a home or business. Include the model number if you can read it safely, but you do not need to open panels or reach a roof to submit a request.\n\nHow much will the work cost?\n\nThe price depends on the diagnosis, parts, access and scope. We explain the proposed work before it begins. An installation or replacement proposal may require a site review to check equipment size, ducts, electrical requirements and access.\n\nCan you help with a commercial property that stays occupied?"
  },
  {
    "id": "S9",
    "sourceUrl": "https://www.sadowski-hvac.com/",
    "text": "## HVAC service in Linden and nearby towns\n\nWe serve homes and commercial properties in Linden and surrounding New Jersey communities. Send the property address so we can confirm availability for your location, equipment and type of work.\n\n- [Rahway](https://www.sadowski-hvac.com/hvac-services-in-rahway-nj/)\n- [Roselle](https://www.sadowski-hvac.com/hvac-services-in-roselle-nj/)\n- [Elizabeth](https://www.sadowski-hvac.com/hvac-services-in-elizabeth-nj/)\n- [Clark](https://www.sadowski-hvac.com/hvac-services-in-clark-nj/)\n- [Cranford](https://www.sadowski-hvac.com/hvac-services-in-cranford-nj/)\n- [Union Township](https://www.sadowski-hvac.com/hvac-services-in-union-township-nj/)\n- [Roselle Park](https://www.sadowski-hvac.com/hvac-services-in-roselle-park-nj/)\n\n[View all service areas →](https://www.sadowski-hvac.com/service-areas/)\n\nBefore you book"
  },
  {
    "id": "S16",
    "sourceUrl": "https://www.sadowski-hvac.com/contact-us/",
    "text": "### How soon do you need service?\n\nUrgent / call todaySame-day if availableThis weekFlexible / planning ahead"
  },
  {
    "id": "S21",
    "sourceUrl": "https://www.sadowski-hvac.com/about-us/",
    "text": "### For businesses and property teams\n\nCommercial work needs to fit the building’s operations. We help with HVAC repairs, maintenance, and equipment replacement, including rooftop units, boilers, and controls. Access hours and tenant schedules are part of planning the work. Our commercial services also include refrigeration.\n\n[Commercial HVAC services →](https://www.sadowski-hvac.com/commercial-hvac/)"
  }
];

export const REPLAY_RAW_DRAFT: Record<string, any> = {
  "categories": [
    {
      "category": "phone_intake",
      "observations": [
        {
          "type": "phone_number_listed",
          "citations": [
            {
              "source": "S7",
              "quote": "Call 732-551-7848"
            }
          ]
        },
        {
          "type": "business_hours_listed",
          "citations": [
            {
              "source": "S7",
              "quote": "Office hours are Monday–Friday, 8:00 AM–5:00 PM."
            }
          ]
        }
      ],
      "unknowns": [
        "first_to_see_request",
        "request_assignment"
      ],
      "hypotheses": [
        {
          "observed": "phone_number_listed",
          "unknown": "first_to_see_request"
        }
      ],
      "discovery_questions": [
        "When a customer calls, who usually takes the initial details and determines the next step?"
      ]
    },
    {
      "category": "website_forms",
      "observations": [
        {
          "type": "contact_form_offered",
          "citations": [
            {
              "source": "S7",
              "quote": "use the request form with your property address and a short description."
            }
          ]
        },
        {
          "type": "form_urgency_selector_offered",
          "citations": [
            {
              "source": "S16",
              "quote": "Urgent / call todaySame-day if availableThis weekFlexible / planning ahead"
            }
          ]
        }
      ],
      "unknowns": [
        "forms_calls_same_system",
        "urgent_identification"
      ],
      "hypotheses": [
        {
          "observed": "form_urgency_selector_offered",
          "unknown": "urgent_identification"
        },
        {
          "observed": "contact_form_offered",
          "unknown": "forms_calls_same_system"
        }
      ],
      "discovery_questions": [
        "When a customer submits the request form, what happens next, and how do you decide who handles it?"
      ]
    },
    {
      "category": "online_booking",
      "observations": [],
      "unknowns": [],
      "hypotheses": [],
      "discovery_questions": []
    },
    {
      "category": "after_hours",
      "observations": [
        {
          "type": "emergency_service_stated",
          "citations": [
            {
              "source": "S4",
              "quote": "Emergency HVAC repair across heating, cooling, and controls."
            }
          ]
        }
      ],
      "unknowns": [
        "after_hours_handling"
      ],
      "hypotheses": [
        {
          "observed": "emergency_service_stated",
          "unknown": "after_hours_handling"
        }
      ],
      "discovery_questions": [
        "How do you handle an emergency HVAC request that comes in outside office hours?"
      ]
    },
    {
      "category": "follow_up",
      "observations": [
        {
          "type": "callback_offered",
          "citations": [
            {
              "source": "S3",
              "quote": "We’ll contact you to discuss the work and scheduling."
            }
          ]
        }
      ],
      "unknowns": [
        "followup_ownership"
      ],
      "hypotheses": [
        {
          "observed": "callback_offered",
          "unknown": "followup_ownership"
        }
      ],
      "discovery_questions": [
        "After you contact someone about their request, who owns any further follow-up?"
      ]
    },
    {
      "category": "crm_integrations",
      "observations": [],
      "unknowns": [
        "crm_usage"
      ],
      "hypotheses": [],
      "discovery_questions": []
    }
  ],
  "primary_opportunity_hypothesis": {
    "category": "after_hours",
    "observed": "urgent_or_emergency_service",
    "unknown": "after_hours_handling"
  },
  "primary_discovery_question": "How do you handle an emergency HVAC request that comes in outside office hours?",
  "preliminary_fit": {
    "signals": [
      {
        "signal": "urgent_or_emergency_service",
        "citations": [
          {
            "source": "S4",
            "quote": "Emergency HVAC repair across heating, cooling, and controls."
          }
        ]
      },
      {
        "signal": "multiple_intake_paths",
        "citations": [
          {
            "source": "S7",
            "quote": "Call [732-551-7848](tel:+17325517848) or use the request form with your property address and a short description."
          }
        ]
      },
      {
        "signal": "broad_service_territory",
        "citations": [
          {
            "source": "S9",
            "quote": "We serve homes and commercial properties in Linden and surrounding New Jersey communities."
          }
        ]
      },
      {
        "signal": "multiple_service_categories",
        "citations": [
          {
            "source": "S21",
            "quote": "We help with HVAC repairs, maintenance, and equipment replacement"
          }
        ]
      }
    ],
    "unknowns": [
      "first_to_see_request",
      "request_assignment",
      "forms_calls_same_system",
      "urgent_identification",
      "after_hours_handling",
      "followup_ownership",
      "response_time",
      "crm_usage"
    ]
  },
  "top_opportunities": [
    {
      "category": "after_hours",
      "observed": "urgent_or_emergency_service",
      "unknown": "after_hours_handling"
    },
    {
      "category": "website_forms",
      "observed": "form_urgency_selector_offered",
      "unknown": "urgent_identification"
    },
    {
      "category": "phone_intake",
      "observed": "multiple_intake_paths",
      "unknown": "first_to_see_request"
    }
  ]
};
